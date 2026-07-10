// Package checkdriver is the CheckDriver family (driver-interfaces §3): one
// package, one small frozen interface, one New selector — the same registry
// idiom as substrate.New. A driver exercises one CheckSpec and emits artifacts
// through evidence.Capture; it never sets check state (verify owns tri-state
// and the proof ladder).
package checkdriver

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/0prodigy/proofbench/internal/evidence"
	"github.com/0prodigy/proofbench/internal/manifest"
)

// CheckDriver kinds.
const (
	KindExec        = "exec"         // default: bash -lc the exercise, teed
	KindPlaywright  = "playwright"   // shells `npx playwright test`; trace/screenshot via cap.File
	KindComputerUse = "computer-use" // reserved (driver-interfaces §3); not implemented here
)

// Env is what substrate + auth resolved before a driver runs. Drivers stay
// substrate-blind: Endpoints always name a localhost:<port> reachable from
// this process.
type Env struct {
	Dir       string            // repo root
	Endpoints map[string]string // resource/service -> host:port reachable from this process
	Vars      map[string]string // auth material injected as env
	Session   string            // validated storageState.json path; "" = none
}

// Driver exercises one CheckSpec. It never sets check state.
type Driver interface {
	// Preflight reports whether this driver can run here (binary on PATH,
	// grants, ...). A Preflight failure makes the check record not-run with
	// this reason (ADR-0012) — never a fail, never a silent pass.
	Preflight() error
	// Exercise runs spec.Exercise, emitting artifacts via capture. The int is
	// the exit code (or driver-mapped equivalent) for exitCode() predicates. A
	// non-nil error is a harness failure: the exercise never ran.
	Exercise(spec manifest.CheckSpec, env Env, capture evidence.Capture) (int, error)
}

// New returns the driver for kind, rooted at dir. kind "" defaults to exec.
func New(kind, dir string) (Driver, error) {
	switch kind {
	case "", KindExec:
		return &execDriver{dir: dir}, nil
	case KindPlaywright:
		return &playwrightDriver{dir: dir}, nil
	default:
		return nil, fmt.Errorf("unknown check driver %q (want exec|playwright)", kind)
	}
}

// Kinds lists the registered driver kinds, for preflight and error text.
func Kinds() []string { return []string{KindExec, KindPlaywright} }

// SubstituteEndpoints replaces resource/endpoint placeholders in s using the
// endpoints map (name -> host:port), keeping drivers substrate-blind:
//
//	${endpoints.<name>}        -> host:port
//	${resources.<name>.host}   -> host
//	${resources.<name>.port}   -> port
//
// An unmatched placeholder is left verbatim so a typo surfaces as a runtime
// error rather than a silent empty substitution.
func SubstituteEndpoints(s string, endpoints map[string]string) string {
	if s == "" || len(endpoints) == 0 {
		return s
	}
	for name, hostport := range endpoints {
		host, port := hostport, ""
		if h, p, ok := strings.Cut(hostport, ":"); ok {
			host, port = h, p
		}
		s = strings.ReplaceAll(s, "${endpoints."+name+"}", hostport)
		s = strings.ReplaceAll(s, "${resources."+name+".host}", host)
		s = strings.ReplaceAll(s, "${resources."+name+".port}", port)
	}
	return s
}

// endpointPlaceholder matches a proofbench endpoint placeholder — the
// ${resources.<name>.host|port} and ${endpoints.<name>} grammar
// SubstituteEndpoints fills. It deliberately does NOT match ordinary shell
// variable expansions (`$FOO`, `${FOO}`, `${FOO:+...}`) so exercises that
// legitimately reference process env are left alone.
var endpointPlaceholder = regexp.MustCompile(`\$\{(?:resources\.[^}]*|endpoints\.[^}]*)\}`)

// UnresolvedEndpoints returns the endpoint placeholders still present in s
// after SubstituteEndpoints — i.e. resources/endpoints the substrate could not
// report a locator for. A non-empty result means the substrate is not attached
// (or a placeholder names a resource the manifest never declared): the check
// must not shell out with a half-substituted command. Ordinary shell
// variables are never returned.
func UnresolvedEndpoints(s string) []string {
	return endpointPlaceholder.FindAllString(s, -1)
}
