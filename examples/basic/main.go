// Command basic-orders is a minimal HTTP service used as the Proofbench
// "basic" example. It exposes:
//
//	GET  /healthz      – liveness probe; always returns 200 OK
//	POST /orders       – appends the request body (JSON) as a line to orders.json
//
// Start with: go run .
// Port: 8391
package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
)

const (
	addr       = ":8391"
	ordersFile = "orders.json"
)

var mu sync.Mutex

func healthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	fmt.Fprintln(w, `{"status":"ok"}`)
}

func createOrder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read error", http.StatusInternalServerError)
		return
	}

	mu.Lock()
	f, err := os.OpenFile(ordersFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		_, err = fmt.Fprintf(f, "%s\n", body)
		f.Close()
	}
	mu.Unlock()

	if err != nil {
		http.Error(w, "write error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintln(w, `{"status":"created"}`)
}

func main() {
	http.HandleFunc("/healthz", healthz)
	http.HandleFunc("/orders", createOrder)
	log.Printf("basic-orders listening on %s", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		log.Fatal(err)
	}
}
