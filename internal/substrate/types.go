// Package substrate provides runtime-selected adapters that bring a service
// up, probe readiness, seed data, and tear down — same manifest, different
// substrate (PLAN.md §3.2).
package substrate

import (
	"fmt"

	"github.com/launchwings/proofbench/internal/manifest"
)

// Substrate kinds.
const (
	KindLocal   = "local"
	KindCompose = "compose"
)

// Substrate is a runtime adapter driven by a readiness manifest.
type Substrate interface {
	// Up brings the service and its resources up on this substrate.
	Up(r *manifest.Ready) error
	// Ready blocks until the manifest's readiness probe passes (or its
	// timeout elapses).
	Ready(r *manifest.Ready) error
	// Seed runs the manifest's seed steps in dependency order.
	Seed(r *manifest.Ready) error
	// Down tears down whatever Up started.
	Down(r *manifest.Ready) error
}

// New returns the substrate adapter for kind, rooted at dir (the repo
// directory containing the manifest). Supported kinds: local, compose.
func New(kind, dir string) (Substrate, error) {
	switch kind {
	case KindLocal:
		return &localSubstrate{dir: dir}, nil
	case KindCompose:
		return &composeSubstrate{dir: dir}, nil
	default:
		return nil, fmt.Errorf("unknown substrate kind %q (want local|compose)", kind)
	}
}
