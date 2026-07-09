package evidence

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// testBundle builds a bundle in a temp dir with the given files and one
// command artifact "build" whose meta exitCode is 0 (plus "jsonBuild" with a
// float64 exit code, as after a JSON round-trip, and "noMeta" without one).
func testBundle(t *testing.T, files map[string]string) *Bundle {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &Bundle{
		Dir: dir,
		M: &Manifest{
			Schema: 2,
			Artifacts: []Artifact{
				{Type: ArtifactCommand, Name: "build", Path: "01-build.log", Meta: map[string]any{"exitCode": 0}},
				{Type: ArtifactCommand, Name: "jsonBuild", Path: "02-json.log", Meta: map[string]any{"exitCode": float64(3)}},
				{Type: ArtifactCommand, Name: "noMeta", Path: "03-nometa.log", Meta: map[string]any{}},
				{Type: ArtifactLog, Name: "notACommand", Path: "04-log.log"},
			},
		},
	}
}

func TestAssert(t *testing.T) {
	b := testBundle(t, map[string]string{
		"full.txt":  "hello",
		"empty.txt": "",
		"arr.json":  `[{"a":1},{"a":2},{"a":3}]`,
		"lines.txt": "one\n\ntwo\n   \nthree\n",
		"copyA.txt": "same bytes",
		"copyB.txt": "same bytes",
		"copyC.txt": "different bytes",
		"exec.json": `{"selectedAction":"full_run","stages":[` +
			`{"name":"validate","state":"SUCCEEDED"},` +
			`{"name":"transform","state":"SUCCEEDED"},` +
			`{"name":"publish","state":"SUCCEEDED"}]}`,
	})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(201)
	}))
	defer srv.Close()
	deadSrv := httptest.NewServer(http.NotFoundHandler())
	deadURL := deadSrv.URL
	deadSrv.Close()

	tests := []struct {
		name     string
		expr     string
		observed string
		ok       bool
		wantErr  bool
	}{
		// exitCode
		{"exitCode match", "exitCode(build)==0", "exitCode=0", true, false},
		{"exitCode mismatch", "exitCode(build)==1", "exitCode=0", false, false},
		{"exitCode float64 meta", "exitCode(jsonBuild)==3", "exitCode=3", true, false},
		{"exitCode with spaces", " exitCode( build ) == 0 ", "exitCode=0", true, false},
		{"exitCode missing artifact", "exitCode(nope)==0", "", false, true},
		{"exitCode non-command artifact", "exitCode(notACommand)==0", "", false, true},
		{"exitCode meta missing key", "exitCode(noMeta)==0", "", false, true},
		{"exitCode non-integer rhs", "exitCode(build)==zero", "", false, true},
		{"exitCode wrong operator", "exitCode(build)=0", "", false, true},

		// nonempty
		{"nonempty file with content", "nonempty(full.txt)", "size=5", true, false},
		{"nonempty empty file", "nonempty(empty.txt)", "size=0", false, false},
		{"nonempty missing file", "nonempty(ghost.txt)", "missing", false, false},
		{"nonempty trailing junk", "nonempty(full.txt)==1", "", false, true},

		// rows
		{"rows json array pass", "rows(arr.json)>2", "rows=3", true, false},
		{"rows json array fail", "rows(arr.json)>3", "rows=3", false, false},
		{"rows line count pass", "rows(lines.txt)>2", "rows=3", true, false},
		{"rows line count fail", "rows(lines.txt)>5", "rows=3", false, false},
		{"rows missing file", "rows(ghost.txt)>0", "", false, true},
		{"rows non-integer rhs", "rows(arr.json)>many", "", false, true},

		// http
		{"http match", "http(" + srv.URL + ")==201", "status=201", true, false},
		{"http mismatch", "http(" + srv.URL + ")==200", "status=201", false, false},
		{"http unreachable", "http(" + deadURL + ")==200", "", false, true},
		{"http non-integer rhs", "http(" + srv.URL + ")==ok", "", false, true},

		// equal
		{"equal identical", "equal(copyA.txt,copyB.txt)", "equal=true", true, false},
		{"equal different", "equal(copyA.txt,copyC.txt)", "equal=false", false, false},
		{"equal with spaces", "equal( copyA.txt , copyB.txt )", "equal=true", true, false},
		{"equal missing file", "equal(copyA.txt,ghost.txt)", "", false, true},
		{"equal one path", "equal(copyA.txt)", "", false, true},

		// jsonpath (reads the execution.json fixture below)
		{"jsonpath equals action", "jsonpath(exec.json,selectedAction)==full_run", "full_run", true, false},
		{"jsonpath differs", "jsonpath(exec.json,selectedAction)==quick_run", "full_run", false, false},
		{"jsonpath nested index", "jsonpath(exec.json,stages.0.name)==validate", "validate", true, false},
		{"jsonpath nested index state", "jsonpath(exec.json,stages.2.state)==SUCCEEDED", "SUCCEEDED", true, false},
		{"jsonpath regex match", "jsonpath(exec.json,selectedAction)~=^full", "full_run", true, false},
		{"jsonpath regex no match", "jsonpath(exec.json,selectedAction)~=^quick", "full_run", false, false},
		{"jsonpath missing key", "jsonpath(exec.json,nope)==x", "", false, true},
		{"jsonpath bad index", "jsonpath(exec.json,stages.9.name)==x", "", false, true},
		{"jsonpath no op", "jsonpath(exec.json,selectedAction)", "", false, true},
		{"jsonpath one arg", "jsonpath(exec.json)==x", "", false, true},

		// contains (ordered stage list / terminal status)
		{"contains stage present", "contains(exec.json,stages,validate)", "contains=true", true, false},
		{"contains stage object field", "contains(exec.json,stages,SUCCEEDED)", "contains=true", true, false},
		{"contains stage absent", "contains(exec.json,stages,deleted)", "contains=false", false, false},
		{"contains scalar", "contains(exec.json,selectedAction,full)", "contains=true", true, false},
		{"contains trailing junk", "contains(exec.json,stages,x)==1", "", false, true},
		{"contains two args", "contains(exec.json,stages)", "", false, true},

		// malformed
		{"no parens", "exitCode==0", "", false, true},
		{"unknown predicate", "sha(full.txt)==0", "", false, true},
		{"empty expr", "", "", false, true},
		{"empty argument", "nonempty()", "", false, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			observed, ok, err := b.Assert(tt.expr)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Assert(%q) err = %v, wantErr %v", tt.expr, err, tt.wantErr)
			}
			if err != nil {
				return
			}
			if observed != tt.observed {
				t.Errorf("Assert(%q) observed = %q, want %q", tt.expr, observed, tt.observed)
			}
			if ok != tt.ok {
				t.Errorf("Assert(%q) ok = %v, want %v", tt.expr, ok, tt.ok)
			}
		})
	}
}

func TestAssertAbsolutePath(t *testing.T) {
	b := testBundle(t, nil)
	outside := filepath.Join(t.TempDir(), "abs.txt")
	if err := os.WriteFile(outside, []byte("x\ny\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	observed, ok, err := b.Assert("nonempty(" + outside + ")")
	if err != nil || !ok || observed != "size=4" {
		t.Errorf("nonempty(abs) = %q, %v, %v; want size=4, true, nil", observed, ok, err)
	}
	observed, ok, err = b.Assert("rows(" + outside + ")>1")
	if err != nil || !ok || observed != "rows=2" {
		t.Errorf("rows(abs)>1 = %q, %v, %v; want rows=2, true, nil", observed, ok, err)
	}
}

func TestCountRowsEdgeCases(t *testing.T) {
	tests := []struct {
		name string
		data string
		want int
	}{
		{"empty json array", "[]", 0},
		{"json object falls back to lines", `{"a":1}`, 1},
		{"empty file", "", 0},
		{"whitespace only", " \n \n", 0},
		{"no trailing newline", "a\nb", 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := countRows([]byte(tt.data)); got != tt.want {
				t.Errorf("countRows(%q) = %d, want %d", tt.data, got, tt.want)
			}
		})
	}
}

// Guard: a false comparison must be ok=false with err=nil, never an error.
func TestFalseComparisonIsNotError(t *testing.T) {
	b := testBundle(t, map[string]string{"e.txt": ""})
	for _, expr := range []string{"exitCode(build)==7", "nonempty(e.txt)", "rows(e.txt)>0"} {
		_, ok, err := b.Assert(expr)
		if ok || err != nil {
			t.Errorf("Assert(%q) = ok=%v err=%v; want ok=false err=nil", expr, ok, err)
		}
	}
}
