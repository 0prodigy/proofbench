package substrate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/launchwings/proofbench/internal/manifest"
)

// ComposeUnavailable is returned when docker (or its compose plugin) cannot
// be used on this host. Its message is the CLI-facing string.
type ComposeUnavailable struct {
	Reason string
}

func (e *ComposeUnavailable) Error() string {
	return "substrate compose unavailable: " + e.Reason
}

// composeSubstrate drives the compose file referenced by the manifest's
// sources (sources.compose), resolving resources via their compose locators.
type composeSubstrate struct {
	dir string
}

// Up runs the equivalent of `docker compose up -d` for the service and its
// resource dependencies.
func (s *composeSubstrate) Up(r *manifest.Ready) error {
	if err := checkCompose(); err != nil {
		return err
	}
	file := composeFile(r)
	if err := s.compose(file, "up", "-d", "--wait"); err == nil {
		return nil
	}
	// ponytail: older compose lacks --wait (and --wait also fails on
	// unhealthy services); retry plain up and do the readiness wait ourselves.
	if err := s.compose(file, "up", "-d"); err != nil {
		return fmt.Errorf("compose up: %w", err)
	}
	return s.Ready(r)
}

// Ready waits for the manifest's readiness probe if one is declared,
// otherwise for every compose service to reach the running state.
func (s *composeSubstrate) Ready(r *manifest.Ready) error {
	if err := checkCompose(); err != nil {
		return err
	}
	p := r.Run.Ready
	if p.HTTP != "" || p.TCP != "" || p.Exec != "" {
		return waitProbe(s.dir, p)
	}
	timeout, interval, err := probeTiming(p)
	if err != nil {
		return err
	}
	file := composeFile(r)
	return poll(timeout, interval, "compose ps (all services running)", func() error {
		return s.allRunning(file)
	})
}

// Seed runs the manifest's seed steps in dependency order against the
// compose stack.
func (s *composeSubstrate) Seed(r *manifest.Ready) error {
	return runSeed(s.dir, r)
}

// Down runs the equivalent of `docker compose down`.
func (s *composeSubstrate) Down(r *manifest.Ready) error {
	if err := checkCompose(); err != nil {
		return err
	}
	if err := s.compose(composeFile(r), "down"); err != nil {
		return fmt.Errorf("compose down: %w", err)
	}
	return nil
}

// composeFile returns the manifest's compose file (sources.compose),
// defaulting to docker-compose.yml.
func composeFile(r *manifest.Ready) string {
	if f := r.Sources["compose"]; f != "" {
		return f
	}
	return "docker-compose.yml"
}

// checkCompose verifies docker + the compose plugin are usable.
func checkCompose() error {
	if _, err := exec.LookPath("docker"); err != nil {
		return &ComposeUnavailable{Reason: "docker not found in PATH"}
	}
	if out, err := exec.Command("docker", "compose", "version").CombinedOutput(); err != nil {
		reason := strings.TrimSpace(string(out))
		if reason == "" {
			reason = err.Error()
		}
		return &ComposeUnavailable{Reason: reason}
	}
	// `compose version` succeeds without a daemon; ping it explicitly so a
	// stopped Docker Desktop degrades as unavailable, not a mid-up failure.
	if out, err := exec.Command("docker", "info", "--format", "{{.ServerVersion}}").CombinedOutput(); err != nil {
		reason := strings.TrimSpace(string(out))
		if reason == "" {
			reason = err.Error()
		}
		return &ComposeUnavailable{Reason: "docker daemon unreachable: " + reason}
	}
	return nil
}

// compose runs `docker compose -f file args...` from s.dir, streaming output.
func (s *composeSubstrate) compose(file string, args ...string) error {
	cmd := exec.Command("docker", append([]string{"compose", "-f", file}, args...)...)
	cmd.Dir = s.dir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// allRunning errors unless `docker compose ps` shows at least one service and
// every service in the running state.
func (s *composeSubstrate) allRunning(file string) error {
	cmd := exec.Command("docker", "compose", "-f", file, "ps", "--format", "json")
	cmd.Dir = s.dir
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("compose ps: %w", err)
	}
	rows, err := parseComposePS(out)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return errors.New("no compose services are up")
	}
	for _, row := range rows {
		if !strings.EqualFold(row.State, "running") {
			return fmt.Errorf("service %s is %s", row.name(), row.State)
		}
	}
	return nil
}

type composePSRow struct {
	Name    string `json:"Name"`
	Service string `json:"Service"`
	State   string `json:"State"`
}

func (r composePSRow) name() string {
	if r.Service != "" {
		return r.Service
	}
	return r.Name
}

// parseComposePS handles both compose ps JSON shapes: one object per line
// (compose >= 2.21) and a single JSON array (older).
func parseComposePS(out []byte) ([]composePSRow, error) {
	txt := strings.TrimSpace(string(out))
	if txt == "" {
		return nil, nil
	}
	if strings.HasPrefix(txt, "[") {
		var rows []composePSRow
		if err := json.Unmarshal([]byte(txt), &rows); err != nil {
			return nil, fmt.Errorf("compose ps output: %w", err)
		}
		return rows, nil
	}
	var rows []composePSRow
	for _, line := range strings.Split(txt, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var row composePSRow
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, fmt.Errorf("compose ps output: %w", err)
		}
		rows = append(rows, row)
	}
	return rows, nil
}
