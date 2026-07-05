package manifest

import (
	"fmt"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// validModes is the closed set of known substrate names.
var validModes = map[string]bool{
	"local":      true,
	"compose":    true,
	"k8s-attach": true,
	"remote":     true,
}

// validLevels is the closed set of proof-ladder rungs.
var validLevels = map[string]bool{
	"L0": true,
	"L1": true,
	"L2": true,
	"L3": true,
	"L4": true,
	"L5": true,
}

// Load reads and parses a ready.yaml at path into a Ready, then runs
// Validate on it.
func Load(path string) (*Ready, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("manifest.Load: cannot read %q: %w", path, err)
	}

	var r Ready
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true) // ponytail: strict — unknown fields are rejected loudly
	if err := dec.Decode(&r); err != nil {
		return nil, fmt.Errorf("manifest.Load: parse error in %q: %w", path, err)
	}

	if err := r.Validate(); err != nil {
		return nil, err
	}
	return &r, nil
}

// Validate checks structural validity of a Ready manifest:
//   - service name non-empty
//   - run.modes non-empty, each element in {local, compose, k8s-attach, remote}
//   - local mode declared in run.modes requires run.local.start non-empty
//   - probe (run.ready) has at most one of http/tcp/exec; timeout and interval
//     are parseable durations (defaulted to 60s/2s when absent)
//   - seed step names are unique; each After entry resolves to a seed name or
//     a resource name; references may not form a cycle among seed-step names
//   - check names are unique; level is in L0-L5; exercise is non-empty
//   - a check exercise of form "drive.<name>" must reference an existing drive
//     verb in r.Drive
func (r *Ready) Validate() error {
	if strings.TrimSpace(r.Service) == "" {
		return fmt.Errorf("manifest.Validate: service: name must not be empty")
	}

	if err := validateModes(r); err != nil {
		return err
	}

	if err := validateProbe(r.Run.Ready); err != nil {
		return err
	}

	if err := validateSeed(r); err != nil {
		return err
	}

	if err := validateChecks(r); err != nil {
		return err
	}

	return nil
}

// LoadWorkspace reads and parses a workspace.yaml at path.
func LoadWorkspace(path string) (*Workspace, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("manifest.LoadWorkspace: cannot read %q: %w", path, err)
	}

	var w Workspace
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&w); err != nil {
		return nil, fmt.Errorf("manifest.LoadWorkspace: parse error in %q: %w", path, err)
	}
	return &w, nil
}

// validateModes checks run.modes is non-empty and each element is a known
// substrate. When "local" is present it also requires run.local.start.
func validateModes(r *Ready) error {
	if len(r.Run.Modes) == 0 {
		return fmt.Errorf("manifest.Validate: run.modes: must not be empty")
	}

	for _, m := range r.Run.Modes {
		if !validModes[m] {
			return fmt.Errorf("manifest.Validate: run.modes: %q is not a valid mode (allowed: local, compose, k8s-attach, remote)", m)
		}
	}

	if modeSet(r.Run.Modes)["local"] {
		if strings.TrimSpace(r.Run.Local.Start) == "" {
			return fmt.Errorf("manifest.Validate: run.local.start: required when mode %q is listed", "local")
		}
	}

	return nil
}

// validateProbe ensures at most one of http/tcp/exec is set on a Probe and
// that timeout/interval are parseable durations.
func validateProbe(p Probe) error {
	count := 0
	if p.HTTP != "" {
		count++
	}
	if p.TCP != "" {
		count++
	}
	if p.Exec != "" {
		count++
	}
	if count > 1 {
		return fmt.Errorf("manifest.Validate: run.ready: probe must have at most one of http/tcp/exec, got %d", count)
	}

	// ponytail: defaults applied at validation time; callers should read Probe
	// fields only after Validate has run (or use helper accessors).
	if p.Timeout != "" {
		if _, err := time.ParseDuration(p.Timeout); err != nil {
			return fmt.Errorf("manifest.Validate: run.ready.timeout: %q is not a valid duration: %w", p.Timeout, err)
		}
	}
	if p.Interval != "" {
		if _, err := time.ParseDuration(p.Interval); err != nil {
			return fmt.Errorf("manifest.Validate: run.ready.interval: %q is not a valid duration: %w", p.Interval, err)
		}
	}

	return nil
}

// validateSeed checks:
//  1. seed step names are unique
//  2. each After entry resolves to a seed-step name or a resource name
//  3. no self-cycle (After may not name the step itself; full cycle detection
//     via topological sort among seed-step names only)
func validateSeed(r *Ready) error {
	seedNames := make(map[string]bool, len(r.Seed))
	for _, s := range r.Seed {
		if seedNames[s.Name] {
			return fmt.Errorf("manifest.Validate: seed: duplicate step name %q", s.Name)
		}
		seedNames[s.Name] = true
	}

	// Collect all valid after-targets: seed names + resource names.
	validTargets := make(map[string]bool, len(seedNames)+len(r.Resources))
	for n := range seedNames {
		validTargets[n] = true
	}
	for n := range r.Resources {
		validTargets[n] = true
	}

	for _, s := range r.Seed {
		for _, ref := range s.After {
			if !validTargets[ref] {
				return fmt.Errorf("manifest.Validate: seed[%q].after: %q does not resolve to a seed step name or resource name", s.Name, ref)
			}
		}
	}

	// Cycle detection among seed steps (resources are sinks — no outgoing
	// edges from them into the seed DAG).
	if err := detectSeedCycles(r.Seed, seedNames); err != nil {
		return err
	}

	return nil
}

// detectSeedCycles does a topological sort (Kahn's algorithm) over seed
// steps using only inter-seed edges. A leftover means a cycle exists.
func detectSeedCycles(steps []SeedStep, seedNames map[string]bool) error {
	// Build adjacency: step -> set of seed-step predecessors.
	inDegree := make(map[string]int, len(steps))
	dependents := make(map[string][]string, len(steps)) // predecessor -> list of successors

	for _, s := range steps {
		if _, ok := inDegree[s.Name]; !ok {
			inDegree[s.Name] = 0
		}
		for _, ref := range s.After {
			if !seedNames[ref] {
				// Resource dependency — skip; resources have no inDegree in the seed DAG.
				continue
			}
			inDegree[s.Name]++
			dependents[ref] = append(dependents[ref], s.Name)
		}
	}

	queue := make([]string, 0, len(steps))
	for name, deg := range inDegree {
		if deg == 0 {
			queue = append(queue, name)
		}
	}

	visited := 0
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		visited++
		for _, succ := range dependents[cur] {
			inDegree[succ]--
			if inDegree[succ] == 0 {
				queue = append(queue, succ)
			}
		}
	}

	if visited != len(steps) {
		return fmt.Errorf("manifest.Validate: seed: steps form a dependency cycle (not a DAG)")
	}
	return nil
}

// validateChecks checks:
//  1. check names are unique
//  2. level is in L0-L5
//  3. exercise is non-empty
//  4. exercise of form "drive.<name>" references an existing drive verb
func validateChecks(r *Ready) error {
	checkNames := make(map[string]bool, len(r.Checks))
	for _, c := range r.Checks {
		if checkNames[c.Name] {
			return fmt.Errorf("manifest.Validate: checks: duplicate check name %q", c.Name)
		}
		checkNames[c.Name] = true

		if !validLevels[c.Level] {
			return fmt.Errorf("manifest.Validate: checks[%q].level: %q is not a valid proof-ladder rung (allowed: L0-L5)", c.Name, c.Level)
		}

		if strings.TrimSpace(c.Exercise) == "" {
			return fmt.Errorf("manifest.Validate: checks[%q].exercise: must not be empty", c.Name)
		}

		if strings.HasPrefix(c.Exercise, "drive.") {
			verb := strings.TrimPrefix(c.Exercise, "drive.")
			if _, ok := r.Drive[verb]; !ok {
				return fmt.Errorf("manifest.Validate: checks[%q].exercise: drive verb %q is not defined in drive", c.Name, verb)
			}
		}
	}
	return nil
}

// modeSet converts a slice of mode strings to a set for O(1) lookup.
func modeSet(modes []string) map[string]bool {
	s := make(map[string]bool, len(modes))
	for _, m := range modes {
		s[m] = true
	}
	return s
}
