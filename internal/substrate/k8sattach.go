package substrate

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/0prodigy/proofbench/internal/manifest"
)

// k8sAttach is the Shape-A attach-only substrate (ADR-0011, k8s-mode.md §7):
// the whole proof runs against an ALREADY-DEPLOYED BYOC cluster. Up never
// creates cluster objects — it asserts pod liveness and opens `kubectl
// port-forward` tunnels for the service and each declared resource so the pb
// process (and its substrate-blind drivers) can dial 127.0.0.1:<port>. Down
// kills only the forwards it opened; it never deletes anything in-cluster.
type k8sAttach struct {
	dir       string
	context   string // kubectl context; "" = current-context
	namespace string // granted namespace to port-forward into
}

// forward records one opened port-forward: what it targets and the local port
// it bound, so Endpoint() can report it and Down() can reap it by pid.
type forward struct {
	Name       string `json:"name"`       // resource/service name
	Locator    string `json:"locator"`    // svc/x, deploy/x, pod/x (with optional :remotePort)
	RemotePort int    `json:"remotePort"` // in-cluster port
	LocalPort  int    `json:"localPort"`  // bound 127.0.0.1 port
	PID        int    `json:"pid"`        // kubectl port-forward pid
}

// newK8sAttach resolves the kubectl context and granted namespace for dir.
// Precedence: PB_K8S_CONTEXT / PB_K8S_NAMESPACE env override a workspace.yaml
// found alongside the manifest dir; a workspace context named "k8s-attach" (or
// the sole context) supplies the default. No cluster credentials are read from
// the repo — only a context name (ADR-0008).
func newK8sAttach(dir string) (*k8sAttach, error) {
	s := &k8sAttach{dir: dir}
	if wsCtx, wsNs, ok := workspaceContext(dir); ok {
		s.context, s.namespace = wsCtx, wsNs
	}
	if v := os.Getenv("PB_K8S_CONTEXT"); v != "" {
		s.context = v
	}
	if v := os.Getenv("PB_K8S_NAMESPACE"); v != "" {
		s.namespace = v
	}
	if s.namespace == "" {
		return nil, errors.New("k8s-attach: no namespace resolved (set PB_K8S_NAMESPACE or a workspace.yaml context 'name@namespace')")
	}
	return s, nil
}

// workspaceContext loads a workspace.yaml adjacent to dir and returns the
// context/namespace for k8s-attach. The Workspace.Contexts map is
// name -> "<kube-context>@<namespace>" (or just "<namespace>"); the entry
// keyed "k8s-attach" wins, else the sole entry.
func workspaceContext(dir string) (kubeCtx, namespace string, ok bool) {
	path := filepath.Join(dir, "workspace.yaml")
	w, err := manifest.LoadWorkspace(path)
	if err != nil || len(w.Contexts) == 0 {
		return "", "", false
	}
	val, found := w.Contexts[KindK8sAttach]
	if !found {
		if len(w.Contexts) != 1 {
			return "", "", false
		}
		for _, v := range w.Contexts {
			val = v
		}
	}
	if c, ns, split := strings.Cut(val, "@"); split {
		return c, ns, true
	}
	return "", val, true // just a namespace, current kube-context
}

// Up asserts liveness and opens a port-forward for the service and each
// resource carrying a Via["k8s"] locator, recording them so Down can reap
// them. sources.k8s and a resource's via.k8s may name the identical locator
// (e.g. both point at svc/appservice:8000) — those are deduplicated into one
// tunnel so both names resolve to it rather than opening a redundant second
// forward. One line is printed per tunnel actually opened, so a successful
// `pb up` is observable rather than silent.
func (s *k8sAttach) Up(r *manifest.Ready) error {
	if err := checkKubectl(); err != nil {
		return err
	}

	targets := s.forwardTargets(r)
	if len(targets) == 0 {
		return errors.New("k8s-attach: no k8s locators to forward (declare resources[*].via.k8s or sources.k8s)")
	}

	opened := make([]forward, 0, len(targets))
	for _, group := range dedupForwardTargets(targets) {
		first := group[0]
		if err := s.assertLive(first.Locator); err != nil {
			s.reap(opened) // roll back forwards opened so far
			return fmt.Errorf("k8s-attach: %s (%s): %w", first.Name, first.Locator, err)
		}
		local, pid, err := s.openForward(first.Locator, first.RemotePort)
		if err != nil {
			s.reap(opened)
			return fmt.Errorf("k8s-attach: port-forward %s (%s): %w", first.Name, first.Locator, err)
		}
		fmt.Printf("forward %s -> 127.0.0.1:%d\n", forwardLabel(first), local)
		for _, t := range group {
			t.LocalPort, t.PID = local, pid
			opened = append(opened, t)
		}
	}
	return s.saveForwards(opened)
}

// dedupForwardTargets groups forwardTargets sharing the same locator+port
// pair into one group, preserving first-seen order, so Up opens exactly one
// tunnel per unique in-cluster target no matter how many manifest names (a
// sources.k8s entry and a resource's via.k8s) reference it.
func dedupForwardTargets(targets []forward) [][]forward {
	order := make([]string, 0, len(targets))
	groups := map[string][]forward{}
	for _, t := range targets {
		key := fmt.Sprintf("%s:%d", t.Locator, t.RemotePort)
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], t)
	}
	out := make([][]forward, 0, len(order))
	for _, key := range order {
		out = append(out, groups[key])
	}
	return out
}

// forwardLabel renders a forward's in-cluster target for the "forward ..."
// progress line: "<locator>:<remotePort>" when a remote port was declared,
// else the bare locator (kubectl then uses the target's own port).
func forwardLabel(f forward) string {
	if f.RemotePort > 0 {
		return fmt.Sprintf("%s:%d", f.Locator, f.RemotePort)
	}
	return f.Locator
}

// Ready polls the manifest's readiness probe against the FORWARDED localhost
// port — the same waitProbe local/compose use. Because Up binds ephemeral
// local ports, the probe target may carry endpoint placeholders
// (${resources.<name>.host/port}, ${endpoints.<name>}); Ready resolves them
// against the forwards Up recorded before polling, keeping the manifest's
// probe substrate-blind.
func (s *k8sAttach) Ready(r *manifest.Ready) error {
	p := r.Run.Ready
	if eps := s.endpointMap(); len(eps) > 0 {
		p.HTTP = substituteEndpoints(p.HTTP, eps)
		p.TCP = substituteEndpoints(p.TCP, eps)
		p.Exec = substituteEndpoints(p.Exec, eps)
	}
	err := waitProbe(s.dir, p)
	if err != nil {
		fmt.Printf("ready %s -> fail: %v\n", probeLabel(p), err)
	} else {
		fmt.Printf("ready %s -> ok\n", probeLabel(p))
	}
	return err
}

// probeLabel renders the declared probe for the "ready ..." progress line.
func probeLabel(p manifest.Probe) string {
	switch {
	case p.HTTP != "":
		return "http " + p.HTTP
	case p.TCP != "":
		return "tcp " + p.TCP
	case p.Exec != "":
		return "exec " + p.Exec
	default:
		return "probe"
	}
}

// endpointMap loads the recorded forwards into a name -> 127.0.0.1:port map,
// returning nil when none are recorded.
func (s *k8sAttach) endpointMap() map[string]string {
	fwds, err := s.loadForwards()
	if err != nil {
		return nil
	}
	out := make(map[string]string, len(fwds))
	for _, f := range fwds {
		out[f.Name] = fmt.Sprintf("127.0.0.1:%d", f.LocalPort)
	}
	return out
}

// substituteEndpoints replaces ${resources.<n>.host/port} and ${endpoints.<n>}
// placeholders with recorded forward addresses. Kept local to the substrate
// (mirrors checkdriver.SubstituteEndpoints) so substrate has no import cycle.
func substituteEndpoints(s string, eps map[string]string) string {
	if s == "" {
		return s
	}
	for name, hostport := range eps {
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

// Seed runs the manifest's seed steps in dependency order — identical to
// local/compose (the seed commands dial the forwarded localhost ports).
func (s *k8sAttach) Seed(r *manifest.Ready) error {
	return runSeed(s.dir, r)
}

// Down kills only the port-forwards this substrate opened (by recorded pid)
// and removes the forwards file. It never deletes cluster objects (Shape-A,
// ADR-0011). Missing/stale state is not an error — Down is idempotent.
func (s *k8sAttach) Down(_ *manifest.Ready) error {
	fwds, err := s.loadForwards()
	if err != nil {
		if os.IsNotExist(err) {
			s.removeEmptyPbDir()
			return nil
		}
		return err
	}
	s.reap(fwds)
	_ = os.Remove(s.forwardsFile())
	s.removeEmptyPbDir()
	return nil
}

// removeEmptyPbDir removes the substrate's .pb directory once Down has
// cleared its own forwards file, but only if that leaves the directory
// empty — os.Remove refuses to remove a non-empty directory, so any other
// substrate/seed state left there is never touched. Best-effort like the
// forwards-file removal above: a failure here is not Down's failure.
func (s *k8sAttach) removeEmptyPbDir() {
	_ = os.Remove(filepath.Join(s.dir, ".pb"))
}

// Endpoint satisfies the optional Endpoints capability: it returns the
// 127.0.0.1:<localPort> this substrate's Up forwarded for name.
func (s *k8sAttach) Endpoint(name string) (string, error) {
	fwds, err := s.loadForwards()
	if err != nil {
		return "", fmt.Errorf("k8s-attach: no forwards recorded (run pb up first): %w", err)
	}
	for _, f := range fwds {
		if f.Name == name {
			return fmt.Sprintf("127.0.0.1:%d", f.LocalPort), nil
		}
	}
	return "", fmt.Errorf("k8s-attach: no forward for %q", name)
}

// Pins satisfies the optional Pinner capability (pins.go): the resolved
// kubectl context/namespace, plus each forwarded target's backing pod image
// digest(s), keyed "image.<name>" — so an evidence bundle can prove WHICH
// build k8s-attach exercised (PLAN §5 "run pinning"). A per-target digest
// lookup failure is skipped, not fatal: pins are best-effort provenance, and
// a missing pin is reported by its absence, never faked.
func (s *k8sAttach) Pins() (map[string]string, error) {
	fwds, err := s.loadForwards()
	if err != nil {
		return nil, fmt.Errorf("k8sAttach.Pins: load forwards: %w", err)
	}
	out := map[string]string{"k8s.namespace": s.namespace}
	if s.context != "" {
		out["k8s.context"] = s.context
	}
	for _, f := range fwds {
		digest, err := s.podImageDigest(f.Locator)
		if err != nil {
			continue
		}
		out["image."+f.Name] = digest
	}
	return out, nil
}

// podImageDigest resolves the concrete pod backing locator (a svc name
// resolves via the Service's own selector when it has one, else the
// "app=<name>" convention; a deploy name resolves via that convention) and
// reads its container image digest(s) via a read-only
// `kubectl get pod -o jsonpath={.status.containerStatuses[*].imageID}`.
func (s *k8sAttach) podImageDigest(locator string) (string, error) {
	pod, err := s.podForLocator(locator)
	if err != nil {
		return "", err
	}
	out, err := s.kubectlOut("get", "pod/"+pod, "-o",
		`jsonpath={range .status.containerStatuses[*]}{.imageID}{","}{end}`)
	if err != nil {
		return "", fmt.Errorf("pod %q imageIDs: %s", pod, out)
	}
	digest := strings.Trim(strings.TrimSpace(out), ",")
	if digest == "" {
		return "", fmt.Errorf("pod %q: no imageIDs reported", pod)
	}
	return digest, nil
}

// podForLocator resolves a forward locator (pod/svc/deploy) to a concrete
// pod name. A deploy name still resolves via the "app=<name>" convention
// (mirroring resolvePod). A svc name first reads the Service's OWN selector
// (real Services often don't follow the "app=<name>" convention — e.g.
// svc/appservice or svc/kafka-cluster-kafka-brokers may select on
// "app.kubernetes.io/name=<name>" or another label entirely) and only falls
// back to "app=<name>" when the Service has no selector or the query fails.
func (s *k8sAttach) podForLocator(locator string) (string, error) {
	kind, name := splitKindName(locator)
	switch kind {
	case "pod":
		return name, nil
	case "svc", "service":
		if sel, ok := s.svcSelector(name); ok {
			return s.firstPod("-l", sel, "--field-selector=status.phase=Running")
		}
		return s.firstPod("-l", "app="+name)
	case "deploy", "deployment":
		return s.firstPod("-l", "app="+name)
	default:
		return "", fmt.Errorf("unsupported locator kind %q", kind)
	}
}

// svcSelector reads a Service's actual label selector via a read-only
// `kubectl get svc <name> -o jsonpath={.spec.selector}` and renders it as a
// "-l" selector string with keys SORTED (k1=v1,k2=v2) for deterministic
// output. ok is false — and the caller falls back to the "app=<name>"
// convention — when the Service has no selector (e.g. a headless/manually
// managed endpoint) or the query fails.
func (s *k8sAttach) svcSelector(name string) (selector string, ok bool) {
	out, err := s.kubectlOut("get", "svc", name, "-o", "jsonpath={.spec.selector}")
	if err != nil {
		return "", false
	}
	trimmed := strings.TrimSpace(out)
	if trimmed == "" {
		return "", false
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(trimmed), &m); err != nil || len(m) == 0 {
		return "", false
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, k := range keys {
		pairs = append(pairs, k+"="+m[k])
	}
	return strings.Join(pairs, ","), true
}

// forwardTargets collects the port-forward targets from the manifest: the
// service (sources.k8s locator, named after r.Service) plus every resource
// with a via.k8s locator. Resource order is deterministic (sorted by name).
func (s *k8sAttach) forwardTargets(r *manifest.Ready) []forward {
	var out []forward
	if loc := r.Sources["k8s"]; loc != "" {
		locator, port := splitLocatorPort(loc)
		out = append(out, forward{Name: serviceName(r), Locator: locator, RemotePort: port})
	}
	names := make([]string, 0, len(r.Resources))
	for name := range r.Resources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		res := r.Resources[name]
		loc := res.Via["k8s"]
		if loc == "" {
			continue
		}
		locator, port := splitLocatorPort(loc)
		out = append(out, forward{Name: name, Locator: locator, RemotePort: port})
	}
	return out
}

// assertLive verifies the target object exists and (for pods/deployments) has
// at least one ready pod, without mutating anything.
func (s *k8sAttach) assertLive(locator string) error {
	kind, name := splitKindName(locator)
	switch kind {
	case "pod":
		return s.assertPodReady("pod/" + name)
	case "deploy", "deployment":
		out, err := s.kubectlOut("get", "deploy", name, "-o", "jsonpath={.status.availableReplicas}")
		if err != nil {
			return fmt.Errorf("deployment %q not found: %s", name, out)
		}
		if strings.TrimSpace(out) == "" || strings.TrimSpace(out) == "0" {
			return fmt.Errorf("deployment %q has no available replicas", name)
		}
		return nil
	case "svc", "service":
		if out, err := s.kubectlOut("get", "svc", name, "-o", "name"); err != nil {
			return fmt.Errorf("service %q not found: %s", name, out)
		}
		return nil
	default:
		return fmt.Errorf("unsupported locator kind %q (want pod|deploy|svc)", kind)
	}
}

func (s *k8sAttach) assertPodReady(podRef string) error {
	out, err := s.kubectlOut("get", podRef, "-o",
		`jsonpath={range .status.conditions[?(@.type=="Ready")]}{.status}{end}`)
	if err != nil {
		return fmt.Errorf("%s not found: %s", podRef, out)
	}
	if strings.TrimSpace(out) != "True" {
		return fmt.Errorf("%s is not Ready", podRef)
	}
	return nil
}

// openForward starts `kubectl port-forward <locator> <local>:<remote>` in its
// own process group and waits until the local port accepts a connection.
func (s *k8sAttach) openForward(locator string, remotePort int) (localPort, pid int, err error) {
	localPort, err = freeLocalPort()
	if err != nil {
		return 0, 0, err
	}
	args := s.baseArgs("port-forward", locator, fmt.Sprintf("%d:%d", localPort, remotePort))
	cmd := exec.Command("kubectl", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return 0, 0, err
	}
	go drain(stderr)
	go func() { _ = cmd.Wait() }()
	pid = cmd.Process.Pid

	deadline := time.Now().Add(15 * time.Second)
	addr := fmt.Sprintf("127.0.0.1:%d", localPort)
	for {
		c, derr := net.DialTimeout("tcp", addr, 500*time.Millisecond)
		if derr == nil {
			c.Close()
			return localPort, pid, nil
		}
		if time.Now().After(deadline) {
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			return 0, 0, fmt.Errorf("forward to %s never came up on %s", locator, addr)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

// reap kills each recorded forward's process group; a dead pid is not an error.
func (s *k8sAttach) reap(fwds []forward) {
	for _, f := range fwds {
		if f.PID > 0 {
			_ = syscall.Kill(-f.PID, syscall.SIGTERM)
		}
	}
}

// baseArgs prefixes kubectl args with --context/--namespace when set.
func (s *k8sAttach) baseArgs(args ...string) []string {
	var pre []string
	if s.context != "" {
		pre = append(pre, "--context", s.context)
	}
	if s.namespace != "" {
		pre = append(pre, "-n", s.namespace)
	}
	return append(pre, args...)
}

func (s *k8sAttach) kubectlOut(args ...string) (string, error) {
	cmd := exec.Command("kubectl", s.baseArgs(args...)...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// ---- env derivation from a live pod (env.derive.from: k8s-pod) ----

// DeriveEnv reads the process environment of the pod named by r's derive spec
// (env.derive.from == "k8s-pod") via `kubectl exec -- env`, returning KEY=VAL
// lines. It is called by the CLI/verify env-resolution path, not by the frozen
// Substrate methods. An empty/absent derive spec returns nil, nil.
func (s *k8sAttach) DeriveEnv(r *manifest.Ready) ([]string, error) {
	d := r.Run.Local.Env.Derive
	if d == nil || d.From == "" {
		return nil, nil
	}
	if d.From != "k8s-pod" {
		return nil, fmt.Errorf("k8s-attach: unsupported env.derive.from %q (want k8s-pod)", d.From)
	}
	pod, err := s.resolvePod(r, d.Pod)
	if err != nil {
		return nil, err
	}
	out, err := s.kubectlOut("exec", pod, "--", "env")
	if err != nil {
		return nil, fmt.Errorf("k8s-attach: derive env from %s: %s", pod, out)
	}
	var env []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "=") {
			continue
		}
		env = append(env, line)
	}
	return env, nil
}

// resolvePod turns a derive.pod selector into a concrete pod name: a bare pod
// name is used as-is; deploy/<n>, svc/<n>, or app=<label> resolve to a pod.
func (s *k8sAttach) resolvePod(r *manifest.Ready, sel string) (string, error) {
	if sel == "" {
		sel = "app=" + serviceName(r)
	}
	switch {
	case strings.HasPrefix(sel, "deploy/"), strings.HasPrefix(sel, "deployment/"):
		_, name := splitKindName(sel)
		return s.firstPod("-l", "app="+name)
	case strings.HasPrefix(sel, "svc/"), strings.HasPrefix(sel, "service/"):
		_, name := splitKindName(sel)
		return s.firstPod("-l", "app="+name)
	case strings.Contains(sel, "="):
		return s.firstPod("-l", sel)
	default:
		return sel, nil // a concrete pod name
	}
}

func (s *k8sAttach) firstPod(args ...string) (string, error) {
	getArgs := append([]string{"get", "pods"}, args...)
	getArgs = append(getArgs, "-o", "jsonpath={.items[0].metadata.name}")
	out, err := s.kubectlOut(getArgs...)
	name := strings.TrimSpace(out)
	if err != nil || name == "" {
		return "", fmt.Errorf("no pod matched %v: %s", args, out)
	}
	return name, nil
}

// ---- forwards persistence ----

func (s *k8sAttach) forwardsFile() string {
	return filepath.Join(s.dir, ".pb", "k8s-forwards.json")
}

func (s *k8sAttach) saveForwards(fwds []forward) error {
	if err := os.MkdirAll(filepath.Join(s.dir, ".pb"), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(fwds, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.forwardsFile(), data, 0o644)
}

func (s *k8sAttach) loadForwards() ([]forward, error) {
	data, err := os.ReadFile(s.forwardsFile())
	if err != nil {
		return nil, err
	}
	var fwds []forward
	if err := json.Unmarshal(data, &fwds); err != nil {
		return nil, err
	}
	return fwds, nil
}

// ---- helpers ----

// checkKubectl verifies kubectl is usable on this host.
func checkKubectl() error {
	if _, err := exec.LookPath("kubectl"); err != nil {
		return errors.New("k8s-attach unavailable: kubectl not found in PATH")
	}
	return nil
}

// splitLocatorPort splits "svc/appservice:8080" into ("svc/appservice", 8080).
// A missing port defaults to 0 (kubectl then uses the target's own port).
func splitLocatorPort(loc string) (locator string, port int) {
	locator = loc
	if kind, rest, ok := strings.Cut(loc, "/"); ok {
		if name, p, hasPort := strings.Cut(rest, ":"); hasPort {
			locator = kind + "/" + name
			port, _ = strconv.Atoi(p)
		}
	} else if name, p, hasPort := strings.Cut(loc, ":"); hasPort {
		locator = name
		port, _ = strconv.Atoi(p)
	}
	return locator, port
}

// splitKindName splits "svc/appservice" into ("svc", "appservice").
func splitKindName(locator string) (kind, name string) {
	if k, n, ok := strings.Cut(locator, "/"); ok {
		return k, n
	}
	return "pod", locator // bare name => a pod
}

// freeLocalPort returns an available 127.0.0.1 port.
func freeLocalPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// drain discards a reader (kubectl port-forward stderr chatter).
func drain(r interface{ Read([]byte) (int, error) }) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
	}
}
