package evidence

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
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
//
// ponytail: five predicates, extend when a real check needs a sixth.
func (b *Bundle) Assert(expr string) (observed string, ok bool, err error) {
	expr = strings.TrimSpace(expr)
	open := strings.Index(expr, "(")
	close := strings.LastIndex(expr, ")")
	if open < 0 || close < open {
		return "", false, fmt.Errorf("malformed expression %q", expr)
	}
	fn := strings.TrimSpace(expr[:open])
	arg := strings.TrimSpace(expr[open+1 : close])
	rest := strings.TrimSpace(expr[close+1:])
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
