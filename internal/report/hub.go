package report

import (
	_ "embed"
	"fmt"
	"html/template"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/0prodigy/proofbench/internal/evidence"
	"gopkg.in/yaml.v3"
)

//go:embed hub.tmpl.html
var hubTmpl string

// hubBundle is the template-facing view of one evidence bundle.
type hubBundle struct {
	// header
	Verdict      string
	VerdictClass string // pass | fail | inconclusive | unknown
	Claim        string
	RunID        string
	Started      string // human timestamp derived from startedAt
	MetaSub      string // phase · kind · cluster · env

	// integration facets (derived from ticket / pins / workspace)
	Ticket         string
	ProofLevel     string   // e.g. "L3"; "—" when uncapped/unset
	SelfAttested   bool     // manifest.selfAttested — render honest badge
	PrimaryProject string   // the service a run is "about" (least-shared pin)
	Services       []string // every app service the run integrated (from pins)
	ServicesJoined string
	Cluster        string // <k8s.context>@<namespace> or surface fallback
	PairRole       string // "before" | "after" | "" (from manifest.kind)
	PairsWith      string // runId of the paired baseline/after bundle

	// seal status (ADR-0015): the verdict is only TRUSTED when its seal verifies
	// against a pinned signer identity; otherwise it is stamped UNVERIFIED so it
	// is never presented as a clean trusted result.
	SealVerified bool
	SealDetail   string

	// body
	Checks    []hubCheck
	Artifacts []hubArtifact

	// derivation scratch (not rendered directly)
	pins        map[string]string
	appServices []string
	sortKey     string // newest first: startedAt falling back to dir name
}

type hubCheck struct {
	Name             string
	State            string
	StateClass       string // pass | fail | notrun
	Expect           string
	Observed         string
	Reason           string
	ObservedOrReason string
}

type hubArtifact struct {
	Name    string
	ArtType string
	RelPath string // path from the hub page's directory — used for img src / href

	// command fields
	IsCommand   bool
	CmdString   string
	HasExitCode bool
	ExitOK      bool
	ExitCode    int
	Duration    string

	// screenshot flag
	IsScreenshot bool
}

// hubProject aggregates every run whose primary service is Name (the
// "Projects integrated" section).
type hubProject struct {
	Name          string
	Runs          int
	Pass          int
	Fail          int
	Inconclusive  int
	LatestVerdict string
	LatestClass   string
	SelfAttested  bool // any run self-attested → the tally is not trusted-green
	Tickets       []string
	TicketsJoined string
	latestSort    string
}

// hubCluster aggregates the target surface runs executed against (the
// "Clusters integrated" section).
type hubCluster struct {
	Name           string // <context>@<namespace>
	Context        string
	Namespace      string
	Substrate      string
	Runs           int
	ProjectNames   []string
	ProjectsJoined string
	Projects       int
	seenProjects   map[string]bool
}

// hubData is the top-level template context.
type hubData struct {
	GeneratedAt string
	Bundles     []hubBundle
	Projects    []hubProject
	Clusters    []hubCluster
	Skipped     []string

	// summary tiles
	TotalRuns         int
	PassCount         int
	FailCount         int
	InconclusiveCount int
	SelfAttestedCount int
	ProjectCount      int
	ClusterCount      int

	// workspace context
	UnexercisedServices []string // workspace services with zero runs
	UnexercisedJoined   string
}

// infraDenylist are image roles treated as shared infrastructure, never a
// "project", when no workspace service list narrows the field. Used only as a
// fallback: when a workspace.yaml is supplied its service set is authoritative.
var infraDenylist = map[string]bool{
	"postgres": true, "postgresql": true, "redis": true, "mysql": true,
	"mongo": true, "mongodb": true, "kafka": true, "zookeeper": true,
	"clickhouse": true, "valkey": true, "rabbitmq": true, "nats": true,
	"elasticsearch": true, "memcached": true,
}

// WriteHub renders the hub with no workspace context. Retained as the stable
// entry point for callers/tests; delegates to WriteHubWithWorkspace.
func WriteHub(root, outFile string, o evidence.ValidateOpts) error {
	return WriteHubWithWorkspace(root, outFile, "", o)
}

// WriteHubWithWorkspace scans root for */manifest.json (schema 1 and 2 via
// evidence.Open), renders a self-contained static index.html to outFile (inline
// CSS, zero JS deps, zero external requests). It derives three founder-facing
// views entirely from the bundles (+ the optional workspaceFile): every
// pipeline run, the distinct projects integrated, and the clusters run against.
// Bundles are shown newest-first. Malformed manifests are skipped with a note —
// never a crash. o carries the verifier's seal expectation (ADR-0015): each
// bundle's verdict is checked via evidence.SealStatus and stamped UNVERIFIED
// unless its seal verifies against the pinned identity, so the hub never
// presents an unchecked verdict as green.
func WriteHubWithWorkspace(root, outFile, workspaceFile string, o evidence.ValidateOpts) error {
	// Ensure output directory exists.
	if err := os.MkdirAll(filepath.Dir(outFile), 0o755); err != nil {
		return fmt.Errorf("hub: mkdir %s: %w", filepath.Dir(outFile), err)
	}

	workspaceServices := loadWorkspaceServices(workspaceFile)

	var bundles []hubBundle
	var skipped []string

	// Walk root looking for */manifest.json at depth 1 (immediate children).
	entries, err := os.ReadDir(root)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("hub: read root %s: %w", root, err)
	}
	// Sort entries so iteration order is defined; we re-sort by sortKey below.
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(root, e.Name())
		mpath := filepath.Join(dir, "manifest.json")
		if _, serr := os.Stat(mpath); os.IsNotExist(serr) {
			continue // no manifest — not a bundle dir, skip silently
		}
		b, oerr := evidence.Open(dir)
		if oerr != nil {
			skipped = append(skipped, fmt.Sprintf("%s — %s", e.Name(), oerr.Error()))
			continue
		}
		hb := buildHubBundle(b, dir, outFile, o, workspaceServices)
		bundles = append(bundles, hb)
	}

	// Also do a deeper walk to find nested manifests (grandchild dirs).
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return nil // skip unreadable entries
		}
		if !d.IsDir() {
			return nil
		}
		// Skip the root itself and immediate children (already handled above).
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil || rel == "." {
			return nil
		}
		parts := strings.Split(rel, string(filepath.Separator))
		if len(parts) <= 1 {
			return nil // immediate child — already handled
		}
		mpath := filepath.Join(path, "manifest.json")
		if _, serr := os.Stat(mpath); os.IsNotExist(serr) {
			return nil
		}
		b, oerr := evidence.Open(path)
		if oerr != nil {
			skipped = append(skipped, fmt.Sprintf("%s — %s", rel, oerr.Error()))
			return fs.SkipDir
		}
		hb := buildHubBundle(b, path, outFile, o, workspaceServices)
		bundles = append(bundles, hb)
		return fs.SkipDir
	})

	// Sort newest-first by startedAt (RFC3339 lexicographic ≡ chronological),
	// falling back to directory name.
	sort.Slice(bundles, func(i, j int) bool {
		return bundles[i].sortKey > bundles[j].sortKey
	})

	// Derive the primary project of each run and the aggregate sections.
	assignPrimaryProjects(bundles)
	data := hubData{
		GeneratedAt: time.Now().UTC().Format("2006-01-02 15:04:05 UTC"),
		Bundles:     bundles,
		Skipped:     skipped,
	}
	aggregate(&data, bundles, workspaceServices)

	// Parse and execute template.
	tmpl, err := template.New("hub").Parse(hubTmpl)
	if err != nil {
		return fmt.Errorf("hub: parse template: %w", err)
	}

	f, err := os.Create(outFile)
	if err != nil {
		return fmt.Errorf("hub: create %s: %w", outFile, err)
	}
	defer f.Close()

	if err := tmpl.Execute(f, data); err != nil {
		return fmt.Errorf("hub: execute template: %w", err)
	}
	return nil
}

// loadWorkspaceServices reads the service names from a proofbench workspace.yaml.
// Returns nil when the path is empty or unreadable — the hub then falls back to
// the infra denylist to tell projects from shared infrastructure.
func loadWorkspaceServices(path string) map[string]bool {
	if path == "" {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var ws struct {
		Services map[string]yaml.Node `yaml:"services"`
	}
	if err := yaml.Unmarshal(raw, &ws); err != nil {
		return nil
	}
	if len(ws.Services) == 0 {
		return nil
	}
	out := make(map[string]bool, len(ws.Services))
	for name := range ws.Services {
		out[name] = true
	}
	return out
}

// isProjectService reports whether an image-pin role names an application
// project (vs shared infra). When a workspace service set is supplied it is
// authoritative; otherwise the infra denylist is used.
func isProjectService(role string, workspace map[string]bool) bool {
	if len(workspace) > 0 {
		return workspace[role]
	}
	return !infraDenylist[role]
}

// appServicesFromPins extracts the application-project roles from a bundle's
// image pins (keys of the form "image.<role>"), sorted and de-duplicated.
func appServicesFromPins(pins map[string]string, workspace map[string]bool) []string {
	seen := map[string]bool{}
	var out []string
	for k := range pins {
		role, ok := strings.CutPrefix(k, "image.")
		if !ok || role == "" {
			continue
		}
		if !isProjectService(role, workspace) {
			continue
		}
		if !seen[role] {
			seen[role] = true
			out = append(out, role)
		}
	}
	sort.Strings(out)
	return out
}

// assignPrimaryProjects picks, for each run, the service it is "about": among
// the app services it pins, the one referenced by the FEWEST runs overall —
// i.e. the most distinguishing role (shared dependencies like inventory recur
// across many runs; the service under test does not). Ties break alphabetically.
func assignPrimaryProjects(bundles []hubBundle) {
	globalRef := map[string]int{}
	for i := range bundles {
		for _, s := range bundles[i].appServices {
			globalRef[s]++
		}
	}
	for i := range bundles {
		svcs := bundles[i].appServices
		bundles[i].Services = svcs
		bundles[i].ServicesJoined = strings.Join(svcs, ", ")
		if len(svcs) == 0 {
			continue
		}
		best := svcs[0]
		for _, s := range svcs[1:] {
			if globalRef[s] < globalRef[best] {
				best = s
			}
		}
		bundles[i].PrimaryProject = best
	}
}

// aggregate builds the Projects, Clusters, summary tiles and unexercised-service
// list from the (already primary-assigned) bundles.
func aggregate(data *hubData, bundles []hubBundle, workspace map[string]bool) {
	data.TotalRuns = len(bundles)

	projByName := map[string]*hubProject{}
	var projOrder []string
	cluByName := map[string]*hubCluster{}
	var cluOrder []string
	exercised := map[string]bool{}

	for i := range bundles {
		b := &bundles[i]
		switch b.VerdictClass {
		case "pass":
			data.PassCount++
		case "fail":
			data.FailCount++
		default:
			data.InconclusiveCount++
		}
		if b.SelfAttested {
			data.SelfAttestedCount++
		}
		for _, s := range b.Services {
			exercised[s] = true
		}

		// project aggregation (by primary service)
		pname := b.PrimaryProject
		if pname == "" {
			pname = "(unattributed)"
		}
		p, ok := projByName[pname]
		if !ok {
			p = &hubProject{Name: pname}
			projByName[pname] = p
			projOrder = append(projOrder, pname)
		}
		p.Runs++
		switch b.VerdictClass {
		case "pass":
			p.Pass++
		case "fail":
			p.Fail++
		default:
			p.Inconclusive++
		}
		if b.SelfAttested {
			p.SelfAttested = true
		}
		if b.Ticket != "" && !contains(p.Tickets, b.Ticket) {
			p.Tickets = append(p.Tickets, b.Ticket)
		}
		// latest verdict = newest run for this project (sortKey desc)
		if b.sortKey > p.latestSort {
			p.latestSort = b.sortKey
			p.LatestVerdict = b.Verdict
			p.LatestClass = b.VerdictClass
		}

		// cluster aggregation
		cname := b.Cluster
		if cname == "" {
			cname = "(unspecified)"
		}
		c, ok := cluByName[cname]
		if !ok {
			c = &hubCluster{Name: cname, seenProjects: map[string]bool{}}
			if ctx, ns := splitCluster(cname); ctx != "" {
				c.Context, c.Namespace = ctx, ns
			}
			c.Substrate = b.pins["substrate"]
			if c.Substrate == "" {
				c.Substrate = b.MetaSub
			}
			cluByName[cname] = c
			cluOrder = append(cluOrder, cname)
		}
		c.Runs++
		if pname != "" && !c.seenProjects[pname] {
			c.seenProjects[pname] = true
			c.ProjectNames = append(c.ProjectNames, pname)
		}
	}

	sort.Strings(projOrder)
	for _, n := range projOrder {
		p := projByName[n]
		sort.Strings(p.Tickets)
		p.TicketsJoined = strings.Join(p.Tickets, ", ")
		data.Projects = append(data.Projects, *p)
	}
	data.ProjectCount = len(data.Projects)

	sort.Strings(cluOrder)
	for _, n := range cluOrder {
		c := cluByName[n]
		sort.Strings(c.ProjectNames)
		c.Projects = len(c.ProjectNames)
		c.ProjectsJoined = strings.Join(c.ProjectNames, ", ")
		data.Clusters = append(data.Clusters, *c)
	}
	data.ClusterCount = len(data.Clusters)

	// workspace services declared but never exercised by any run
	var unex []string
	for s := range workspace {
		if !exercised[s] {
			unex = append(unex, s)
		}
	}
	sort.Strings(unex)
	data.UnexercisedServices = unex
	data.UnexercisedJoined = strings.Join(unex, ", ")
}

// splitCluster splits "<context>@<namespace>" into its parts.
func splitCluster(name string) (ctx, ns string) {
	if i := strings.LastIndex(name, "@"); i >= 0 {
		return name[:i], name[i+1:]
	}
	return name, ""
}

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

// buildHubBundle converts an open Bundle into a hubBundle view model.
// outFile is the hub page being written: artifact hrefs are resolved from
// its directory, not from the bundle dir. o carries the seal expectation used
// to stamp the verdict TRUSTED or UNVERIFIED (ADR-0015). workspace narrows which
// image pins count as projects vs infra.
func buildHubBundle(b *evidence.Bundle, dir, outFile string, o evidence.ValidateOpts, workspace map[string]bool) hubBundle {
	m := b.M
	sealVerified, sealDetail := evidence.SealStatus(dir, o)

	// Artifact paths in the manifest are bundle-relative, but the hub page
	// lives elsewhere (e.g. .pb/hub/index.html): link via the relative path
	// from the page's directory to the bundle, falling back to the absolute
	// bundle dir when Rel fails.
	hrefBase, aerr := filepath.Abs(dir)
	if aerr != nil {
		hrefBase = dir
	}
	if outDir, oerr := filepath.Abs(filepath.Dir(outFile)); oerr == nil {
		if rel, rerr := filepath.Rel(outDir, hrefBase); rerr == nil {
			hrefBase = rel
		}
	}

	// sortKey: prefer startedAt (RFC3339 lexsort = chrono), then dir name.
	sortKey := m.StartedAt
	if sortKey == "" {
		sortKey = filepath.Base(dir)
	}

	// verdict class for CSS
	vc := verdictClass(m.Verdict)

	// meta sub-line: phase · kind · surface values (cluster, env, substrate, ...)
	var metaParts []string
	if m.Phase != "" {
		metaParts = append(metaParts, m.Phase)
	}
	if m.Kind != "" {
		metaParts = append(metaParts, m.Kind)
	}
	// surface keys in a priority order, then alphabetical remainder
	for _, k := range []string{"cluster", "env", "substrate"} {
		if v, ok := m.Surface[k]; ok {
			metaParts = append(metaParts, v)
		}
	}
	for _, k := range sortedKV(m.Surface) {
		if k == "cluster" || k == "env" || k == "substrate" {
			continue
		}
		metaParts = append(metaParts, m.Surface[k])
	}
	metaSub := strings.Join(metaParts, " · ")

	// checks
	checks := make([]hubCheck, 0, len(m.Checks))
	for _, c := range m.Checks {
		sc := stateClass(c.State)
		obs := c.Observed
		if obs == "" {
			obs = c.Reason
		}
		checks = append(checks, hubCheck{
			Name:             c.Name,
			State:            c.State,
			StateClass:       sc,
			Expect:           c.Expect,
			Observed:         c.Observed,
			Reason:           c.Reason,
			ObservedOrReason: obs,
		})
	}

	// artifacts
	arts := make([]hubArtifact, 0, len(m.Artifacts))
	for _, a := range m.Artifacts {
		ha := hubArtifact{
			Name:    a.Name,
			ArtType: a.Type,
		}
		if a.Path != "" {
			if filepath.IsAbs(a.Path) {
				ha.RelPath = a.Path
			} else {
				ha.RelPath = filepath.Join(hrefBase, a.Path)
			}
		}
		switch a.Type {
		case evidence.ArtifactCommand:
			ha.IsCommand = true
			if a.Meta != nil {
				if cmd, ok := a.Meta["cmd"].(string); ok {
					ha.CmdString = cmd
				}
				exitCode, hasExit := extractInt(a.Meta, "exitCode")
				if hasExit {
					ha.HasExitCode = true
					ha.ExitCode = exitCode
					ha.ExitOK = exitCode == 0
				}
				dur, hasDur := extractFloat(a.Meta, "durationSec")
				if hasDur {
					if dur == float64(int(dur)) {
						ha.Duration = fmt.Sprintf("%d", int(dur))
					} else {
						ha.Duration = fmt.Sprintf("%.1f", dur)
					}
				}
			}
		case evidence.ArtifactScreenshot:
			ha.IsScreenshot = true
		}
		arts = append(arts, ha)
	}

	// integration facets
	proof := m.ProofLevel
	if proof == "" {
		proof = "—"
	}
	cluster := clusterName(m)
	pairRole := ""
	switch m.Kind {
	case "before", "after":
		pairRole = m.Kind
	}

	return hubBundle{
		Verdict:      m.Verdict,
		VerdictClass: vc,
		Claim:        m.Claim,
		RunID:        m.RunID,
		Started:      displayTime(m.StartedAt),
		MetaSub:      metaSub,
		Ticket:       m.Ticket,
		ProofLevel:   proof,
		SelfAttested: m.SelfAttested,
		Cluster:      cluster,
		PairRole:     pairRole,
		PairsWith:    m.PairsWith,
		SealVerified: sealVerified,
		SealDetail:   sealDetail,
		Checks:       checks,
		Artifacts:    arts,
		pins:         m.Pins,
		appServices:  appServicesFromPins(m.Pins, workspace),
		sortKey:      sortKey,
	}
}

// clusterName derives the target surface identity of a run: the k8s context and
// namespace pinned in the manifest ("<context>@<namespace>"), falling back to
// the surface cluster/env when no k8s pins are present.
func clusterName(m *evidence.Manifest) string {
	ctx := m.Pins["k8s.context"]
	ns := m.Pins["k8s.namespace"]
	if ctx != "" {
		if ns != "" {
			return ctx + "@" + ns
		}
		return ctx
	}
	if c := m.Surface["cluster"]; c != "" {
		if e := m.Surface["env"]; e != "" && e != c {
			return c + "@" + e
		}
		return c
	}
	if e := m.Surface["env"]; e != "" {
		return e
	}
	return ""
}

// displayTime renders an RFC3339 startedAt as "YYYY-MM-DD HH:MM:SS UTC".
func displayTime(s string) string {
	if s == "" {
		return ""
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.UTC().Format("2006-01-02 15:04:05 UTC")
	}
	return s
}

// verdictClass maps a verdict string to a CSS class fragment.
func verdictClass(v string) string {
	switch v {
	case evidence.VerdictPass:
		return "pass"
	case evidence.VerdictFail:
		return "fail"
	case evidence.VerdictInconclusive:
		return "inconclusive"
	default:
		return "unknown"
	}
}

// stateClass maps a check state to a CSS class fragment.
func stateClass(s string) string {
	switch s {
	case evidence.CheckPass:
		return "pass"
	case evidence.CheckFail:
		return "fail"
	default:
		return "notrun"
	}
}

// extractInt pulls an integer-ish value from a map[string]any.
func extractInt(m map[string]any, key string) (int, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	}
	return 0, false
}

// extractFloat pulls a float64 value from a map[string]any.
func extractFloat(m map[string]any, key string) (float64, bool) {
	v, ok := m[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
