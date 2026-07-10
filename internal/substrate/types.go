// Package substrate provides runtime-selected adapters that bring a service
// up, probe readiness, seed data, and tear down — same manifest, different
// substrate (PLAN.md §3.2).
package substrate

import (
	"fmt"

	"github.com/0prodigy/proofbench/internal/manifest"
)

// Substrate kinds.
const (
	KindLocal     = "local"
	KindCompose   = "compose"
	KindK8sAttach = "k8s-attach"
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

// Endpoints is an OPTIONAL substrate capability (driver-interfaces §4),
// discovered by type assertion — never a 5th Substrate method, so the
// Substrate interface stays frozen. It reports where a resource or the
// service is reachable FROM THE PB PROCESS. local/compose need not implement
// it (their locators are already local); k8s-attach does, returning the
// 127.0.0.1:<forwarded-port> its Up opened.
type Endpoints interface {
	Endpoint(name string) (hostport string, err error)
}

// New returns the substrate adapter for kind, rooted at dir (the repo
// directory containing the manifest). Supported kinds: local, compose,
// k8s-attach.
func New(kind, dir string) (Substrate, error) {
	switch kind {
	case KindLocal:
		return &localSubstrate{dir: dir}, nil
	case KindCompose:
		return &composeSubstrate{dir: dir}, nil
	case KindK8sAttach:
		return newK8sAttach(dir)
	default:
		return nil, fmt.Errorf("unknown substrate kind %q (want local|compose|k8s-attach)", kind)
	}
}
