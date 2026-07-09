package manifest

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Detect inspects dir with no ready.yaml present and proposes a generated
// Ready manifest by deriving from existing truth: docker-compose files,
// Procfile, package.json scripts, Makefile, and go.mod. Derive, don't
// restate — the generated manifest points into those sources rather than
// duplicating them.
//
// Detect never fails hard: an empty dir yields a minimal Ready with the
// service name set to the directory basename, a TODO role, and a TODO start
// command placeholder so the proposed manifest still validates (PLAN §4
// "zero-config day one" — pb init always writes a file). The returned
// error is the result of (*Ready).Validate() on the proposed manifest; callers
// may still use the manifest and surface the validation error as edit hints.
//
// NOTE: detects only what exists on disk; no network, no exec, no shell.
func Detect(dir string) (*Ready, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	svc := filepath.Base(abs)
	if svc == "." || svc == "/" {
		svc = "service"
	}

	r := &Ready{
		Service: svc,
		Role:    "TODO: describe this service",
		Sources: map[string]string{},
	}

	// Collect findings from each source file. Order: compose > package.json >
	// Procfile > Makefile > go.mod (later sources fill gaps left by earlier ones).
	composeFile := detectComposeFile(dir, r)
	detectPackageJSON(dir, r)
	detectProcfile(dir, r)
	detectMakefile(dir, r)
	detectGoMod(dir, r)

	// Populate Sources map with the files we found.
	if composeFile != "" {
		r.Sources["compose"] = composeFile
	}

	// Ensure run.modes is non-empty: add "local" if we have a start command,
	// "compose" if we have a compose file; fall back to ["local"] so Validate
	// doesn't reject an empty modes list.
	modesSet := map[string]bool{}
	for _, m := range r.Run.Modes {
		modesSet[m] = true
	}
	if composeFile != "" && !modesSet["compose"] {
		r.Run.Modes = append(r.Run.Modes, "compose")
		modesSet["compose"] = true
	}
	if r.Run.Local.Start != "" && !modesSet["local"] {
		r.Run.Modes = append([]string{"local"}, r.Run.Modes...)
	}
	if len(r.Run.Modes) == 0 {
		r.Run.Modes = []string{"local"}
	}

	// "local" declared (possibly as the fallback mode) but no start command
	// detected: emit a TODO placeholder so the generated manifest validates
	// and pb init always writes a file. The command itself marks the TODO.
	if modeSet(r.Run.Modes)["local"] && strings.TrimSpace(r.Run.Local.Start) == "" {
		r.Run.Local.Start = "echo TODO: set your start command"
	}

	// Remove empty Sources map so it marshals cleanly.
	if len(r.Sources) == 0 {
		r.Sources = nil
	}

	verr := r.Validate()
	return r, verr
}

// detectComposeFile looks for docker-compose.yml / docker-compose.yaml /
// compose.yaml / compose.yml and parses services into resources. Returns the
// relative path of the compose file found (or "").
func detectComposeFile(dir string, r *Ready) string {
	candidates := []string{
		"docker-compose.yml",
		"docker-compose.yaml",
		"compose.yaml",
		"compose.yml",
	}
	for _, name := range candidates {
		path := filepath.Join(dir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		// Found a compose file.
		parseComposeInto(data, name, r)
		return name
	}
	return ""
}

// composeTop is the minimal shape we parse from a compose file.
type composeTop struct {
	Services map[string]composeService `yaml:"services"`
}

type composeService struct {
	DependsOn   interface{}         `yaml:"depends_on"` // list or map
	Healthcheck *composeHealthcheck `yaml:"healthcheck"`
	Ports       []string            `yaml:"ports"`
	Command     string              `yaml:"command"`
}

type composeHealthcheck struct {
	Test interface{} `yaml:"test"`
}

func parseComposeInto(data []byte, _ string, r *Ready) {
	var top composeTop
	if err := yaml.Unmarshal(data, &top); err != nil {
		// NOTE: best-effort; ignore unparseable compose files.
		return
	}
	if r.Resources == nil {
		r.Resources = map[string]Resource{}
	}
	for name, svc := range top.Services {
		res := Resource{
			Type: "service",
			Via:  map[string]string{"compose": name},
		}
		// Note healthcheck presence.
		// (The resource type stays "service"; healthcheck info is captured via
		// the probe on the run spec if this is the primary service, but for deps
		// we just record the compose locator.)
		_ = svc.Healthcheck // healthcheck noted; could extend Resource in the future
		r.Resources[name] = res
	}
	// depends_on relationships are noted in the YAML source; we don't replicate
	// them in our schema since the compose file is the authoritative source.
}

// detectPackageJSON reads scripts.dev|start -> run.local.start and
// scripts.test -> an L2 "unit" check.
func detectPackageJSON(dir string, r *Ready) {
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return
	}
	var pkg struct {
		Scripts map[string]string `yaml:"scripts"`
	}
	// package.json is JSON; yaml.v3 parses JSON as a subset of YAML.
	if err := yaml.Unmarshal(data, &pkg); err != nil {
		return
	}
	r.Sources["packagejson"] = "package.json"

	// Prefer "dev" over "start" for local development start command.
	if r.Run.Local.Start == "" {
		if _, ok := pkg.Scripts["dev"]; ok {
			r.Run.Local.Start = "npm run dev"
		} else if _, ok := pkg.Scripts["start"]; ok {
			r.Run.Local.Start = "npm run start"
		}
	}

	// Add a unit-test check if a test script exists.
	if _, ok := pkg.Scripts["test"]; ok {
		if !hasCheckNamed(r, "unit") {
			r.Checks = append(r.Checks, CheckSpec{
				Name:     "unit",
				Level:    "L2",
				Exercise: "npm test",
				Expect:   []string{"exitCode(unit)==0"},
			})
		}
	}
}

// detectProcfile reads Procfile: web: <cmd> -> run.local.start.
func detectProcfile(dir string, r *Ready) {
	data, err := os.ReadFile(filepath.Join(dir, "Procfile"))
	if err != nil {
		return
	}
	r.Sources["procfile"] = "Procfile"
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		proc, cmd, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		proc = strings.TrimSpace(proc)
		cmd = strings.TrimSpace(cmd)
		if proc == "web" && r.Run.Local.Start == "" && cmd != "" {
			r.Run.Local.Start = cmd
		}
	}
}

// detectMakefile looks for targets run|dev|start -> local start command and
// test -> an L2 check.
func detectMakefile(dir string, r *Ready) {
	data, err := os.ReadFile(filepath.Join(dir, "Makefile"))
	if err != nil {
		return
	}
	r.Sources["makefile"] = "Makefile"

	startTargets := []string{"run", "dev", "start"}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		// A Makefile target line starts at column 0 followed by ':'.
		if strings.HasPrefix(line, ".") || strings.HasPrefix(line, "\t") {
			continue
		}
		target, _, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		target = strings.TrimSpace(target)
		if r.Run.Local.Start == "" {
			for _, st := range startTargets {
				if target == st {
					r.Run.Local.Start = "make " + target
					break
				}
			}
		}
		if target == "test" && !hasCheckNamed(r, "unit") {
			r.Checks = append(r.Checks, CheckSpec{
				Name:     "unit",
				Level:    "L2",
				Exercise: "make test",
				Expect:   []string{"exitCode(unit)==0"},
			})
		}
	}
}

// detectGoMod reads go.mod and, if a main package is present in dir, proposes
// "go run ." as the start command. Also adds a go test check.
func detectGoMod(dir string, r *Ready) {
	_, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return
	}
	r.Sources["gomod"] = "go.mod"

	// Check for main package: look for any *.go file in dir declaring "package main".
	isMain := dirHasMainPackage(dir)

	if isMain && r.Run.Local.Start == "" {
		r.Run.Local.Start = "go run ."
	}

	// Add go test check if not already added by Makefile detection.
	if !hasCheckNamed(r, "unit") {
		r.Checks = append(r.Checks, CheckSpec{
			Name:     "unit",
			Level:    "L2",
			Exercise: "go test ./...",
			Expect:   []string{"exitCode(unit)==0"},
		})
	}
}

// dirHasMainPackage returns true if any .go file at the top level of dir
// contains "package main".
func dirHasMainPackage(dir string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		// Best-effort: look for "package main" as a line prefix.
		for _, line := range strings.Split(string(data), "\n") {
			if strings.TrimSpace(line) == "package main" {
				return true
			}
		}
	}
	return false
}

// hasCheckNamed returns true if r already has a check with the given name.
func hasCheckNamed(r *Ready, name string) bool {
	for _, c := range r.Checks {
		if c.Name == name {
			return true
		}
	}
	return false
}
