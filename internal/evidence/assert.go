package evidence

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var assertHTTPClient = &http.Client{Timeout: 10 * time.Second}

// Assert evaluates a predicate expression against the bundle's artifacts
// and environment, returning the observed value as a string, whether the
// predicate held, and any evaluation error (bad grammar, missing artifact).
//
// Grammar (one predicate per call):
//
//	exitCode(<artifactName>)==<int>   exit code recorded in the named
//	                                  command artifact's meta equals <int>
//	nonempty(<path>)                  file at <path> (bundle-relative or
//	                                  absolute) exists and has size > 0
//	rows(<path>)><int>                if the file parses as a JSON array,
//	                                  its length; otherwise its non-empty
//	                                  line count — must exceed <int>
//	http(<url>)==<int>                GET <url> returns status code <int>
//	equal(<pathA>,<pathB>)            the two files are byte-identical
//	jsonpath(<art>,<path>)==<value>   the dotted JSON path resolved in the
//	                                  named artifact equals <value> (string
//	                                  compare; scalars stringified)
//	jsonpath(<art>,<path>)~=<regex>   the resolved JSON value matches <regex>
//	contains(<art>,<path>,<value>)    the resolved JSON value — a scalar,
//	                                  array element, array of objects' fields,
//	                                  or object value — contains <value>
//
// The jsonpath/contains predicates read a captured mongo/appservice JSON
// document (e.g. an execution doc): path segments are dotted keys, with a
// bare numeric segment indexing into an array (execution.stages.0.state).
// NOTE: dotted-key + numeric-index paths only — no wildcards or filters;
// contains scans one level of array/object for the value.
func (b *Bundle) Assert(expr string) (observed string, ok bool, err error) {
	expr = strings.TrimSpace(expr)
	open := strings.Index(expr, "(")
	closeIdx := strings.LastIndex(expr, ")")
	if open < 0 || closeIdx < open {
		return "", false, fmt.Errorf("malformed expression %q", expr)
	}
	fn := strings.TrimSpace(expr[:open])
	arg := strings.TrimSpace(expr[open+1 : closeIdx])
	rest := strings.TrimSpace(expr[closeIdx+1:])
	if arg == "" {
		return "", false, fmt.Errorf("malformed expression %q: empty argument", expr)
	}

	switch fn {
	case "exitCode":
		want, err := parseRHS(expr, rest, "==")
		if err != nil {
			return "", false, err
		}
		got, err := b.commandExitCode(arg)
		if err != nil {
			return "", false, err
		}
		return fmt.Sprintf("exitCode=%d", got), got == want, nil

	case "nonempty":
		if rest != "" {
			return "", false, fmt.Errorf("malformed expression %q: unexpected %q after nonempty(...)", expr, rest)
		}
		fi, err := os.Stat(b.resolve(arg))
		if os.IsNotExist(err) {
			return "missing", false, nil
		}
		if err != nil {
			return "", false, err
		}
		return fmt.Sprintf("size=%d", fi.Size()), fi.Size() > 0, nil

	case "rows":
		want, err := parseRHS(expr, rest, ">")
		if err != nil {
			return "", false, err
		}
		data, err := os.ReadFile(b.resolve(arg))
		if err != nil {
			return "", false, err
		}
		n := countRows(data)
		return fmt.Sprintf("rows=%d", n), n > want, nil

	case "http":
		want, err := parseRHS(expr, rest, "==")
		if err != nil {
			return "", false, err
		}
		resp, err := assertHTTPClient.Get(arg)
		if err != nil {
			return "", false, err
		}
		resp.Body.Close()
		return fmt.Sprintf("status=%d", resp.StatusCode), resp.StatusCode == want, nil

	case "equal":
		if rest != "" {
			return "", false, fmt.Errorf("malformed expression %q: unexpected %q after equal(...)", expr, rest)
		}
		parts := strings.SplitN(arg, ",", 2)
		if len(parts) != 2 {
			return "", false, fmt.Errorf("malformed expression %q: equal needs two paths", expr)
		}
		a, err := os.ReadFile(b.resolve(strings.TrimSpace(parts[0])))
		if err != nil {
			return "", false, err
		}
		c, err := os.ReadFile(b.resolve(strings.TrimSpace(parts[1])))
		if err != nil {
			return "", false, err
		}
		eq := bytes.Equal(a, c)
		return fmt.Sprintf("equal=%t", eq), eq, nil

	case "jsonpath":
		artName, path, ok := strings.Cut(arg, ",")
		if !ok {
			return "", false, fmt.Errorf("malformed expression %q: jsonpath needs <artifact>,<path>", expr)
		}
		val, err := b.jsonValue(strings.TrimSpace(artName), strings.TrimSpace(path))
		if err != nil {
			return "", false, err
		}
		got := scalarString(val)
		switch {
		case strings.HasPrefix(rest, "=="):
			want := strings.TrimSpace(rest[2:])
			return got, got == want, nil
		case strings.HasPrefix(rest, "~="):
			pat := strings.TrimSpace(rest[2:])
			re, err := regexp.Compile(pat)
			if err != nil {
				return "", false, fmt.Errorf("malformed expression %q: bad regex %q: %w", expr, pat, err)
			}
			return got, re.MatchString(got), nil
		default:
			return "", false, fmt.Errorf("malformed expression %q: expected == or ~= after jsonpath(...)", expr)
		}

	case "contains":
		if rest != "" {
			return "", false, fmt.Errorf("malformed expression %q: unexpected %q after contains(...)", expr, rest)
		}
		parts := strings.SplitN(arg, ",", 3)
		if len(parts) != 3 {
			return "", false, fmt.Errorf("malformed expression %q: contains needs <artifact>,<path>,<value>", expr)
		}
		val, err := b.jsonValue(strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]))
		if err != nil {
			return "", false, err
		}
		want := strings.TrimSpace(parts[2])
		found := jsonContains(val, want)
		return fmt.Sprintf("contains=%t", found), found, nil

	default:
		return "", false, fmt.Errorf("malformed expression %q: unknown predicate %q", expr, fn)
	}
}

// parseRHS checks that rest is op followed by an integer and returns it.
func parseRHS(expr, rest, op string) (int, error) {
	if !strings.HasPrefix(rest, op) {
		return 0, fmt.Errorf("malformed expression %q: expected %q", expr, op)
	}
	n, err := strconv.Atoi(strings.TrimSpace(rest[len(op):]))
	if err != nil {
		return 0, fmt.Errorf("malformed expression %q: %q is not an integer", expr, strings.TrimSpace(rest[len(op):]))
	}
	return n, nil
}

// commandExitCode finds the command artifact named name and returns its
// recorded meta exitCode.
func (b *Bundle) commandExitCode(name string) (int, error) {
	for _, a := range b.M.Artifacts {
		if a.Type != ArtifactCommand || a.Name != name {
			continue
		}
		v, present := a.Meta["exitCode"]
		if !present {
			return 0, fmt.Errorf("command artifact %q has no exitCode in meta", name)
		}
		// exitCode is int when set in-process, float64 after a JSON round-trip.
		switch n := v.(type) {
		case int:
			return n, nil
		case int64:
			return int(n), nil
		case float64:
			return int(n), nil
		case json.Number:
			i, err := n.Int64()
			return int(i), err
		}
		return 0, fmt.Errorf("command artifact %q exitCode is not a number", name)
	}
	return 0, fmt.Errorf("no command artifact named %q", name)
}

// countRows returns the JSON array length if data is a JSON array, else the
// count of non-empty lines.
func countRows(data []byte) int {
	var arr []json.RawMessage
	if json.Unmarshal(data, &arr) == nil {
		return len(arr)
	}
	n := 0
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// jsonValue reads the JSON document from the named artifact (or a bundle/cwd
// path) and walks path, a dotted key sequence where a bare numeric segment
// indexes into an array. It returns the resolved value (any) for comparison.
func (b *Bundle) jsonValue(artifact, path string) (any, error) {
	data, err := os.ReadFile(b.artifactPath(artifact))
	if err != nil {
		return nil, fmt.Errorf("jsonpath: read %q: %w", artifact, err)
	}
	var doc any
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("jsonpath: %q is not JSON: %w", artifact, err)
	}
	cur := doc
	if strings.TrimSpace(path) == "" {
		return cur, nil
	}
	for _, seg := range strings.Split(path, ".") {
		seg = strings.TrimSpace(seg)
		switch node := cur.(type) {
		case map[string]any:
			v, ok := node[seg]
			if !ok {
				return nil, fmt.Errorf("jsonpath: %q has no key %q in %q", artifact, seg, path)
			}
			cur = v
		case []any:
			idx, err := strconv.Atoi(seg)
			if err != nil {
				return nil, fmt.Errorf("jsonpath: %q needs a numeric index at %q, got %q", artifact, path, seg)
			}
			if idx < 0 || idx >= len(node) {
				return nil, fmt.Errorf("jsonpath: %q index %d out of range in %q", artifact, idx, path)
			}
			cur = node[idx]
		default:
			return nil, fmt.Errorf("jsonpath: %q cannot descend into %q at %q", artifact, seg, path)
		}
	}
	return cur, nil
}

// artifactPath resolves an artifact reference: first by artifact name (its
// recorded on-disk path), then falling back to a bundle/cwd path via resolve.
func (b *Bundle) artifactPath(ref string) string {
	for _, a := range b.M.Artifacts {
		if a.Name == ref && a.Path != "" {
			if filepath.IsAbs(a.Path) {
				return a.Path
			}
			return filepath.Join(b.Dir, a.Path)
		}
	}
	return b.resolve(ref)
}

// scalarString renders a resolved JSON value as a string for equality/regex
// comparison: strings verbatim, numbers without trailing zeros, bools, null,
// and composite values as compact JSON.
func scalarString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case nil:
		return "null"
	default:
		out, _ := json.Marshal(x)
		return string(out)
	}
}

// jsonContains reports whether want appears in v: a scalar equal to want, an
// array with an element equal to want or an element object having a field
// equal to want, or an object with a value equal to want. One level deep.
func jsonContains(v any, want string) bool {
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if scalarString(e) == want {
				return true
			}
			if obj, ok := e.(map[string]any); ok {
				for _, fv := range obj {
					if scalarString(fv) == want {
						return true
					}
				}
			}
		}
		return false
	case map[string]any:
		for _, fv := range x {
			if scalarString(fv) == want {
				return true
			}
		}
		return false
	default:
		return scalarString(v) == want || strings.Contains(scalarString(v), want)
	}
}

// resolve makes p absolute against the bundle dir unless it already is.
// If the file is absent in the bundle but present relative to the working
// directory (ready.yaml expects like rows(orders.json)), the cwd path wins.
func (b *Bundle) resolve(p string) string {
	if filepath.IsAbs(p) {
		return p
	}
	in := filepath.Join(b.Dir, p)
	if _, err := os.Stat(in); err == nil {
		return in
	}
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return in
}
