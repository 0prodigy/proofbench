package manifest

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// scaffoldStartCmd is the literal placeholder Detect writes into
// run.local.start when it cannot derive a real start command for a repo that
// declares (or falls back to) the "local" mode. Validate rejects this exact
// string (see parse.go's isScaffold) wherever a manifest expects a real
// runnable command, so an unedited generated manifest fails `pb lint`
// instead of silently passing. Defined once here and referenced from
// Validate so the generator and the check can never drift apart.
const scaffoldStartCmd = "echo TODO: set your start command"

// Detect inspects dir with no ready.yaml present and proposes a generated
// Ready manifest by deriving from existing truth: docker-compose files,
// Procfile, package.json scripts, Makefile, go.mod, a grepped readiness
// probe, seed/drive scripts, and k8s manifests. Derive, don't restate — the
// generated manifest points into those sources rather than duplicating them.
//
// Detect never fails hard: an empty dir yields a minimal Ready with the
// service name set to the directory basename, a TODO role, and a TODO start
// command placeholder (PLAN §4 "zero-config day one" — pb init always
// writes a file). The returned error is the result of (*Ready).Validate() on
// the proposed manifest; callers may still use the manifest and surface the
// validation error as edit hints. Validate deliberately rejects that same
// TODO start placeholder (so an unedited draft fails `pb lint`); Detect
// recognizes that one expected, self-inflicted condition via errors.Is and
// does not return it, so `pb init` still succeeds in writing the draft — any
// other validation failure is still returned.
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

	// Best-effort extras: a readiness probe grepped from source, seed/drive
	// scripts, and k8s-attach awareness. None of these can make Detect fail —
	// they only add to what the source-derived detectors above already found.
	detectReadyProbe(dir, r)
	detectSeedScripts(dir, r)
	detectDriveScripts(dir, r)
	detectK8sManifests(dir, r)

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
	// detected: emit a TODO placeholder so pb init always writes a file; the
	// verr handling below keeps Detect from surfacing this as an init
	// failure even though Validate (pb lint) rejects it.
	if modeSet(r.Run.Modes)["local"] && strings.TrimSpace(r.Run.Local.Start) == "" {
		r.Run.Local.Start = scaffoldStartCmd
	}

	// Remove empty Sources map so it marshals cleanly.
	if len(r.Sources) == 0 {
		r.Sources = nil
	}

	verr := r.Validate()
	if errors.Is(verr, errScaffoldStart) {
		// Detect's own TODO placeholder is expected to fail Validate — pb
		// init must still write the draft; pb lint (Load -> Validate on the
		// written file) still catches an unedited scaffold.
		verr = nil
	}
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

// detectPackageJSON reads scripts.dev|start -> run.local.start,
// scripts.test -> an L2 "unit" check, and db:seed-style scripts -> a seed
// step.
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

	// db:seed-style scripts (e.g. "seed", "db:seed", "seed:db") propose a
	// seed step, sorted for deterministic output.
	keys := make([]string, 0, len(pkg.Scripts))
	for k := range pkg.Scripts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if !strings.Contains(strings.ToLower(k), "seed") {
			continue
		}
		if hasSeedNamed(r, k) {
			continue
		}
		r.Seed = append(r.Seed, SeedStep{Name: k, Run: "npm run " + k})
	}
}

// detectProcfile reads Procfile process-type entries ("web: <cmd>", "worker:
// <cmd>", ...) and expands them into run.local.start: a single entry becomes
// that command verbatim; multiple entries are joined into one runnable shell
// line ("cmd1 & cmd2 & ... & wait") so pb init never proposes an unrunnable
// manifest for a Procfile-only repo (a real cold-onboarding finding: falling
// through to a Makefile "run" target that requires foreman is not
// runnable). MarshalProposal annotates the multi-entry case with a proposal
// comment on the start line.
func detectProcfile(dir string, r *Ready) {
	data, err := os.ReadFile(filepath.Join(dir, "Procfile"))
	if err != nil {
		return
	}
	r.Sources["procfile"] = "Procfile"

	var cmds []string
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		_, cmd, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		cmd = strings.TrimSpace(cmd)
		if cmd == "" {
			continue
		}
		cmds = append(cmds, cmd)
	}
	if len(cmds) == 0 || r.Run.Local.Start != "" {
		return
	}
	if len(cmds) == 1 {
		r.Run.Local.Start = cmds[0]
		return
	}
	r.Run.Local.Start = strings.Join(cmds, " & ") + " & wait"
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

// hasSeedNamed returns true if r already has a seed step with the given name.
func hasSeedNamed(r *Ready, name string) bool {
	for _, s := range r.Seed {
		if s.Name == name {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------- ready probe

// healthPathTokens are the literal quoted path tokens detectReadyProbe looks
// for, most specific first: a repo using "/healthz" names it deliberately, so
// prefer it over a bare "/health" match found elsewhere in the same source.
var healthPathTokens = []string{"/healthz", "/health"}

// portRe grep-matches a 2-5 digit port near a listen/addr/env-default
// keyword: Go's `ListenAndServe(":8080"`/`Addr: ":8080"`, Node's
// `.listen(3000)`/`process.env.PORT || 3000`, Python's
// `os.environ.get("PORT", 8080)`. Best-effort: a nearby unrelated number can
// false-positive; that is an acceptable trade for "no probe" today.
var portRe = regexp.MustCompile(`(?i)(?:listen(?:andserve)?|addr|port)\W{1,15}?(\d{2,5})\b`)

// sourceScanExts bounds detectReadyProbe's grep to common application source
// files — no lockfiles, binaries, or generated assets.
var sourceScanExts = map[string]bool{
	".go": true, ".py": true, ".rb": true, ".java": true,
	".js": true, ".jsx": true, ".ts": true, ".tsx": true,
}

// sourceScanSkipDirs are directories detectReadyProbe and detectK8sManifests
// never descend into: dependency trees, VCS metadata, and pb's own state.
var sourceScanSkipDirs = map[string]bool{
	".git": true, "node_modules": true, "vendor": true, ".venv": true,
	"venv": true, "dist": true, "build": true, "target": true, ".pb": true,
}

// detectReadyProbe grep-scans source files for a "/healthz" or "/health"
// handler-registration path plus a listen port (listen address or env
// default), proposing run.ready.http "<port><path>" only when both are
// found — best-effort, never a guess from just one signal. When nothing is
// found run.ready is left unset; MarshalProposal notes the gap with a TODO
// comment rather than pb init silently proposing no probe at all.
func detectReadyProbe(dir string, r *Ready) {
	if r.Run.Ready.HTTP != "" || r.Run.Ready.TCP != "" || r.Run.Ready.Exec != "" {
		return // a probe is already set
	}

	var path, port string
	for _, token := range healthPathTokens {
		if path != "" {
			break
		}
		walkSourceFiles(dir, func(_ string, lines []string) {
			if path != "" {
				return
			}
			for _, line := range lines {
				if matchesQuoted(line, token) {
					path = token
					return
				}
			}
		})
	}
	walkSourceFiles(dir, func(_ string, lines []string) {
		if port != "" {
			return
		}
		for _, line := range lines {
			if m := portRe.FindStringSubmatch(line); m != nil {
				port = m[1]
				return
			}
		}
	})

	if path != "" && port != "" {
		r.Run.Ready.HTTP = ":" + port + path
	}
}

// matchesQuoted reports whether line contains token wrapped in matching
// quote characters ("...", '...', or `...`).
func matchesQuoted(line, token string) bool {
	for _, q := range []string{`"`, `'`, "`"} {
		if strings.Contains(line, q+token+q) {
			return true
		}
	}
	return false
}

// walkSourceFiles calls fn(path, lines) for every source file (by
// sourceScanExts) under dir, in deterministic (lexical) order, skipping
// sourceScanSkipDirs. Unreadable files are silently skipped — this is a
// best-effort grep, never a hard failure.
func walkSourceFiles(dir string, fn func(path string, lines []string)) {
	_ = filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if sourceScanSkipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !sourceScanExts[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		fn(path, strings.Split(string(data), "\n"))
		return nil
	})
}

// -------------------------------------------------------------- seed/drive

// detectSeedScripts proposes a seed step for each scripts/seed*.sh file,
// sorted for deterministic output. db:seed-style package.json scripts are
// proposed by detectPackageJSON instead.
func detectSeedScripts(dir string, r *Ready) {
	names := readDirSorted(filepath.Join(dir, "scripts"))
	for _, name := range names {
		if !strings.HasPrefix(name, "seed") || !strings.HasSuffix(name, ".sh") {
			continue
		}
		stepName := strings.TrimSuffix(name, ".sh")
		if hasSeedNamed(r, stepName) {
			continue
		}
		r.Seed = append(r.Seed, SeedStep{
			Name: stepName,
			Run:  "bash scripts/" + name,
		})
	}
}

// detectDriveScripts proposes a drive verb, named after the script, for each
// executable scripts/*.sh file — excluding scripts/seed*.sh, which
// detectSeedScripts already proposes as a seed step, not a drive verb.
func detectDriveScripts(dir string, r *Ready) {
	scriptsDir := filepath.Join(dir, "scripts")
	names := readDirSorted(scriptsDir)
	for _, name := range names {
		if !strings.HasSuffix(name, ".sh") || strings.HasPrefix(name, "seed") {
			continue
		}
		info, err := os.Stat(filepath.Join(scriptsDir, name))
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			continue // not executable, or vanished between readdir and stat
		}
		verb := strings.TrimSuffix(name, ".sh")
		if _, ok := r.Drive[verb]; ok {
			continue
		}
		if r.Drive == nil {
			r.Drive = map[string]DriveVerb{}
		}
		r.Drive[verb] = DriveVerb{Run: "bash scripts/" + name}
	}
}

// readDirSorted returns the sorted basenames of dir's entries, or nil if dir
// does not exist or cannot be read.
func readDirSorted(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

// ------------------------------------------------------------- k8s-attach

// k8sDoc is the minimal shape detectK8sManifests parses out of a Kubernetes
// manifest document: enough to recognize a Service and its first port.
type k8sDoc struct {
	Kind     string `yaml:"kind"`
	Metadata struct {
		Name string `yaml:"name"`
	} `yaml:"metadata"`
	Spec struct {
		Ports []struct {
			Port int `yaml:"port"`
		} `yaml:"ports"`
	} `yaml:"spec"`
}

// detectK8sManifests scans deploy/**/*.y?ml, k8s/, and manifests/ for
// Kubernetes Service documents (multi-document YAML via yaml.v3; unparsable
// documents stop that file's scan silently rather than failing Detect).
// When Services are found it adds "k8s-attach" to run.modes, proposes
// sources.k8s + a resources entry for the Service matching the repo/module
// name (falling back to the first Service found), a resources entry for
// every other Service found, and — when no probe is set yet — a TCP
// readiness probe against the matched service's placeholder. Shape mirrors
// fixtures/k8s-attach/eng-17397-actions-controls.ready.yaml.
func detectK8sManifests(dir string, r *Ready) {
	type service struct {
		name, port string
	}
	var services []service
	seen := map[string]bool{}

	for _, path := range collectK8sManifestFiles(dir) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		dec := yaml.NewDecoder(strings.NewReader(string(data)))
		for {
			var doc k8sDoc
			if err := dec.Decode(&doc); err != nil {
				break // EOF, or an unparsable document: stop this file, silently
			}
			if doc.Kind != "Service" || doc.Metadata.Name == "" || seen[doc.Metadata.Name] {
				continue
			}
			port := ""
			if len(doc.Spec.Ports) > 0 {
				port = strconv.Itoa(doc.Spec.Ports[0].Port)
			}
			services = append(services, service{name: doc.Metadata.Name, port: port})
			seen[doc.Metadata.Name] = true
		}
	}
	if len(services) == 0 {
		return
	}
	sort.Slice(services, func(i, j int) bool { return services[i].name < services[j].name })

	// Prefer the Service matching the repo/module name; else the first found.
	primary := services[0]
	for _, s := range services {
		if s.name == r.Service {
			primary = s
			break
		}
	}

	if !modeSet(r.Run.Modes)["k8s-attach"] {
		r.Run.Modes = append(r.Run.Modes, "k8s-attach")
	}

	locator := func(s service) string {
		if s.port == "" {
			return "svc/" + s.name
		}
		return fmt.Sprintf("svc/%s:%s", s.name, s.port)
	}
	r.Sources["k8s"] = locator(primary)

	if r.Resources == nil {
		r.Resources = map[string]Resource{}
	}
	for _, s := range services {
		r.Resources[s.name] = Resource{
			Type: "service",
			Via:  map[string]string{"k8s": locator(s)},
		}
	}

	if r.Run.Ready.HTTP == "" && r.Run.Ready.TCP == "" && r.Run.Ready.Exec == "" {
		r.Run.Ready.TCP = fmt.Sprintf("${resources.%s.host}:${resources.%s.port}", primary.name, primary.name)
		r.Run.Ready.Timeout = "60s"
		r.Run.Ready.Interval = "2s"
	}
}

// collectK8sManifestFiles returns the sorted, absolute paths of *.yml/*.yaml
// files under dir's deploy/, k8s/, and manifests/ directories (recursively;
// a missing directory is silently skipped).
func collectK8sManifestFiles(dir string) []string {
	var files []string
	for _, root := range []string{"deploy", "k8s", "manifests"} {
		base := filepath.Join(dir, root)
		if info, err := os.Stat(base); err != nil || !info.IsDir() {
			continue
		}
		_ = filepath.WalkDir(base, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if sourceScanSkipDirs[d.Name()] {
					return filepath.SkipDir
				}
				return nil
			}
			switch strings.ToLower(filepath.Ext(path)) {
			case ".yml", ".yaml":
				files = append(files, path)
			}
			return nil
		})
	}
	sort.Strings(files)
	return files
}

// ---------------------------------------------------------- proposal YAML

// MarshalProposal renders r as YAML in the same hand-written house style as
// examples/basic/ready.yaml: empty placeholder fields (an unset sources map,
// an unset run.local.env, an unset probe, empty resources/seed/drive/checks/
// gates/known_walls, an unset check driver or empty artifacts list) are
// omitted rather than dumped as "http: \"\"" / "artifacts: []" noise. types.go
// is frozen (no `omitempty` tags to add there), so the cleanup happens here,
// post-encode, on the yaml.Node tree — plus two proposal comments Detect's
// callers can't attach to the struct itself: a "joined N Procfile entries"
// note on a multi-entry run.local.start, and a TODO on a run.ready that
// Detect could not confidently propose.
func MarshalProposal(r *Ready) ([]byte, error) {
	var root yaml.Node
	if err := root.Encode(r); err != nil {
		return nil, fmt.Errorf("manifest.MarshalProposal: encode: %w", err)
	}
	pruneEmptyNode(&root)
	annotateProcfileStart(&root, r)
	annotateReadyTODO(&root, r)

	data, err := yaml.Marshal(&root)
	if err != nil {
		return nil, fmt.Errorf("manifest.MarshalProposal: marshal: %w", err)
	}
	return data, nil
}

// pruneEmptyNode recursively drops mapping entries whose value is an empty
// scalar (""), null, empty mapping, or empty sequence.
func pruneEmptyNode(n *yaml.Node) {
	switch n.Kind {
	case yaml.MappingNode:
		kept := n.Content[:0]
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, val := n.Content[i], n.Content[i+1]
			pruneEmptyNode(val)
			if isEmptyValueNode(val) {
				continue
			}
			kept = append(kept, key, val)
		}
		n.Content = kept
	case yaml.SequenceNode:
		for _, c := range n.Content {
			pruneEmptyNode(c)
		}
	}
}

// isEmptyValueNode reports whether a mapping value node carries no
// information worth showing in a generated-from-scratch proposal.
func isEmptyValueNode(n *yaml.Node) bool {
	switch n.Kind {
	case yaml.ScalarNode:
		return n.Tag == "!!null" || (n.Tag == "!!str" && n.Value == "")
	case yaml.MappingNode, yaml.SequenceNode:
		return len(n.Content) == 0
	}
	return false
}

// findMappingPath walks a chain of mapping keys, returning the final value
// node or nil if any key along path is absent.
func findMappingPath(n *yaml.Node, path ...string) *yaml.Node {
	cur := n
	for _, key := range path {
		if cur.Kind != yaml.MappingNode {
			return nil
		}
		next := (*yaml.Node)(nil)
		for i := 0; i+1 < len(cur.Content); i += 2 {
			if cur.Content[i].Value == key {
				next = cur.Content[i+1]
				break
			}
		}
		if next == nil {
			return nil
		}
		cur = next
	}
	return cur
}

// annotateProcfileStart adds a proposal comment to run.local.start when
// detectProcfile joined multiple Procfile entries into one shell line.
func annotateProcfileStart(root *yaml.Node, r *Ready) {
	if !strings.HasSuffix(r.Run.Local.Start, " & wait") {
		return
	}
	n := findMappingPath(root, "run", "local", "start")
	if n == nil {
		return
	}
	entries := strings.Count(r.Run.Local.Start, " & ")
	n.LineComment = fmt.Sprintf("proposal: %d Procfile process types joined for local dev; consider a process manager", entries)
}

// annotateReadyTODO leaves a TODO comment on an empty run.ready section:
// pruneEmptyNode already dropped it (an unset Probe has nothing to show), so
// this re-adds a bare "ready:" key to hang the comment on.
func annotateReadyTODO(root *yaml.Node, r *Ready) {
	if r.Run.Ready != (Probe{}) {
		return // a probe was proposed; nothing to flag
	}
	runNode := findMappingPath(root, "run")
	if runNode == nil || runNode.Kind != yaml.MappingNode {
		return
	}
	keyNode := &yaml.Node{
		Kind:        yaml.ScalarNode,
		Tag:         "!!str",
		Value:       "ready",
		HeadComment: "TODO: pb init could not confidently detect a readiness probe; set run.ready.http|tcp|exec",
	}
	valNode := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	runNode.Content = append(runNode.Content, keyNode, valNode)
}
