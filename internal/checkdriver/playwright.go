package checkdriver

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/launchwings/proofbench/internal/evidence"
	"github.com/launchwings/proofbench/internal/manifest"
)

// playwrightDriver shells `npx playwright test <spec>` and attaches the trace
// and screenshots it produces to the bundle via cap.File (provenance tool,
// ADR-0013). Scoped to a single spec file — the stage-log screenshot spec this
// proof needs; computer-use is out of scope.
type playwrightDriver struct {
	dir string
}

// Preflight requires npx on PATH; a miss makes the check not-run with this
// reason (ADR-0012), never a fail.
func (d *playwrightDriver) Preflight() error {
	if _, err := exec.LookPath("npx"); err != nil {
		return fmt.Errorf("playwright driver unavailable: npx not found in PATH")
	}
	return nil
}

// Exercise runs the playwright spec named by spec.Exercise, directing its
// output at a per-check dir inside the bundle so traces/screenshots land where
// cap.File can seal them. Endpoints are injected as PB_ENDPOINT_<NAME> env so
// the spec dials localhost without baking cluster hostnames.
func (d *playwrightDriver) Exercise(spec manifest.CheckSpec, env Env, cap evidence.Capture) (int, error) {
	specFile := strings.TrimSpace(spec.Exercise)
	if specFile == "" {
		return 0, fmt.Errorf("playwright: check %q has an empty exercise (spec path)", spec.Name)
	}

	outDir := filepath.Join(cap.BundleDir(), "playwright-"+spec.Name)
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return 0, fmt.Errorf("playwright: mkdir output: %w", err)
	}

	// Build env: endpoints as PB_ENDPOINT_<NAME>, plus auth Vars and session.
	envv := os.Environ()
	for name, hostport := range env.Endpoints {
		envv = append(envv, "PB_ENDPOINT_"+strings.ToUpper(sanitize(name))+"="+hostport)
	}
	for k, v := range env.Vars {
		envv = append(envv, k+"="+v)
	}
	if env.Session != "" {
		envv = append(envv, "PB_SESSION="+env.Session)
	}
	envv = append(envv, "PLAYWRIGHT_OUTPUT_DIR="+outDir)

	// Run via the capture so the driver's own stdout/exit is recorded as a
	// harness-provenance command artifact; the tool-produced files below are
	// sealed separately as provenance tool.
	cmd := SubstituteEndpoints(
		fmt.Sprintf("npx playwright test %s --output %s --trace on", shellQuote(specFile), shellQuote(outDir)),
		env.Endpoints,
	)
	// Persist the assembled env to the spawned shell by prefixing exports.
	exports := envExports(env)
	code, err := cap.Exec(spec.Name, []string{exports + cmd}, true)
	if err != nil {
		return 0, err
	}

	// Attach any trace/screenshot artifacts playwright wrote (provenance tool).
	_ = filepath.WalkDir(outDir, func(p string, e os.DirEntry, walkErr error) error {
		if walkErr != nil || e.IsDir() {
			return nil
		}
		typ := evidence.ArtifactLog
		switch strings.ToLower(filepath.Ext(p)) {
		case ".png", ".jpg", ".jpeg":
			typ = evidence.ArtifactScreenshot
		case ".webm", ".mp4":
			typ = evidence.ArtifactRecording
		case ".zip": // playwright trace bundle
			typ = evidence.ArtifactRecording
		}
		_ = cap.File(typ, spec.Name+"-"+e.Name(), p, map[string]any{"tool": "playwright"})
		return nil
	})

	return code, nil
}

// envExports renders the driver env as a leading `export K=V; ...` prefix so a
// bash -lc command inherits endpoints/auth without leaking into the harness.
func envExports(env Env) string {
	var b strings.Builder
	for name, hostport := range env.Endpoints {
		fmt.Fprintf(&b, "export PB_ENDPOINT_%s=%s; ", strings.ToUpper(sanitize(name)), shellQuote(hostport))
	}
	for k, v := range env.Vars {
		fmt.Fprintf(&b, "export %s=%s; ", k, shellQuote(v))
	}
	if env.Session != "" {
		fmt.Fprintf(&b, "export PB_SESSION=%s; ", shellQuote(env.Session))
	}
	return b.String()
}

// sanitize maps a resource/service name to an env-var-safe token.
func sanitize(s string) string {
	return strings.NewReplacer("-", "_", ".", "_", "/", "_").Replace(s)
}

// shellQuote single-quotes s for safe interpolation into a bash -lc string.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
