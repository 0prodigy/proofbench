package main

import (
	"encoding/json"
	"os"
	"sort"
	"testing"

	"github.com/launchwings/proofbench/internal/checkdriver"
	"github.com/launchwings/proofbench/internal/manifest"
)

// TestCheckDriverKindsAcceptedByManifest proves every checkdriver.Kinds()
// value is a driver manifest check validation accepts: internal/manifest
// cannot import internal/checkdriver (checkdriver already imports manifest —
// it would cycle), so parse.go's validDrivers set is hand-synced. If a new
// driver is registered in checkdriver without updating validDrivers, this
// test catches it.
func TestCheckDriverKindsAcceptedByManifest(t *testing.T) {
	for _, kind := range checkdriver.Kinds() {
		t.Run(kind, func(t *testing.T) {
			r := &manifest.Ready{
				Service: "lockstep-svc",
				Run: manifest.RunSpec{
					Modes: []string{"remote"},
				},
				Checks: []manifest.CheckSpec{
					{
						Name:     "check-" + kind,
						Level:    "L0",
						Driver:   kind,
						Exercise: "echo ok",
					},
				},
			}
			if err := r.Validate(); err != nil {
				t.Errorf("checkdriver kind %q rejected by manifest.Validate: %v", kind, err)
			}
		})
	}
}

// readySchemaDriverEnum parses spec/v0/ready.schema.json and returns the
// $defs.CheckSpec.properties.driver enum values it declares.
func readySchemaDriverEnum(t *testing.T) []string {
	t.Helper()

	data, err := os.ReadFile("../../spec/v0/ready.schema.json")
	if err != nil {
		t.Fatalf("read ready.schema.json: %v", err)
	}

	var doc struct {
		Defs struct {
			CheckSpec struct {
				Properties struct {
					Driver struct {
						Enum []string `json:"enum"`
					} `json:"driver"`
				} `json:"properties"`
			} `json:"CheckSpec"`
		} `json:"$defs"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse ready.schema.json: %v", err)
	}

	enum := doc.Defs.CheckSpec.Properties.Driver.Enum
	if len(enum) == 0 {
		t.Fatal("ready.schema.json: $defs.CheckSpec.properties.driver.enum is empty or not found at the expected path")
	}
	return enum
}

// TestReadySchemaDriverEnumMatchesCheckDriverKinds pins the hand-synced
// validDrivers list in internal/manifest/parse.go: the driver enum declared
// in spec/v0/ready.schema.json, unioned with "" (absent/default, not
// representable in the JSON enum of an optional field), must equal
// checkdriver.Kinds() unioned with "". Drift in either direction — a new
// driver added to one without the other — fails this test.
func TestReadySchemaDriverEnumMatchesCheckDriverKinds(t *testing.T) {
	schemaEnum := readySchemaDriverEnum(t)

	got := withEmpty(schemaEnum)
	want := withEmpty(checkdriver.Kinds())

	sort.Strings(got)
	sort.Strings(want)

	if len(got) != len(want) {
		t.Fatalf("driver enum mismatch: schema+{\"\"}=%v, checkdriver.Kinds()+{\"\"}=%v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("driver enum mismatch: schema+{\"\"}=%v, checkdriver.Kinds()+{\"\"}=%v", got, want)
		}
	}
}

// withEmpty returns a new slice containing vals plus "", deduplicated.
func withEmpty(vals []string) []string {
	set := map[string]bool{"": true}
	for _, v := range vals {
		set[v] = true
	}
	out := make([]string, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	return out
}
