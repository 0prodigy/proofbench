package substrate

// Pinner is an OPTIONAL substrate capability (driver-interfaces §4 idiom,
// mirroring Endpoints in types.go), discovered by type assertion — never a
// 5th Substrate method, so the Substrate interface stays frozen. It reports
// pinned identifiers (image digests, cluster context/namespace, ...) for
// whatever this substrate exercised, so an evidence bundle can prove WHICH
// build it ran against (PLAN §5: "run pinning — SHAs/versions of everything
// exercised"). local/compose need not implement it; k8s-attach does.
type Pinner interface {
	Pins() (map[string]string, error)
}
