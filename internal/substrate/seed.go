package substrate

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/launchwings/proofbench/internal/manifest"
)

// runSeed executes r.Seed steps in topological order of their After
// dependencies, from dir, streaming output. It stops at the first failure,
// naming the failed step. Shared by all substrate adapters.
func runSeed(dir string, r *manifest.Ready) error {
	order, err := seedOrder(r.Seed)
	if err != nil {
		return err
	}
	for _, step := range order {
		fmt.Printf("seed: %s\n", step.Name)
		cmd := exec.Command("bash", "-lc", step.Run)
		cmd.Dir = dir
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("seed step %q: %w", step.Name, err)
		}
	}
	return nil
}

// seedOrder topologically sorts steps by their After references to other
// steps, keeping manifest order among ready steps. After refs that name no
// step (e.g. resources like "db" in PLAN §4) are satisfied by Up and ignored
// here. A dependency cycle is an error.
func seedOrder(steps []manifest.SeedStep) ([]manifest.SeedStep, error) {
	byName := make(map[string]int, len(steps))
	for i, st := range steps {
		if _, dup := byName[st.Name]; dup {
			return nil, fmt.Errorf("seed: duplicate step name %q", st.Name)
		}
		byName[st.Name] = i
	}
	indeg := make([]int, len(steps))
	dependents := make([][]int, len(steps))
	for i, st := range steps {
		for _, a := range st.After {
			if j, ok := byName[a]; ok {
				dependents[j] = append(dependents[j], i)
				indeg[i]++
			}
		}
	}
	// ponytail: O(n²) Kahn scan — seed lists are tiny.
	order := make([]manifest.SeedStep, 0, len(steps))
	done := make([]bool, len(steps))
	for len(order) < len(steps) {
		next := -1
		for i := range steps {
			if !done[i] && indeg[i] == 0 {
				next = i
				break
			}
		}
		if next < 0 {
			for i := range steps {
				if !done[i] {
					return nil, fmt.Errorf("seed: dependency cycle involving step %q", steps[i].Name)
				}
			}
		}
		done[next] = true
		order = append(order, steps[next])
		for _, d := range dependents[next] {
			indeg[d]--
		}
	}
	return order, nil
}
