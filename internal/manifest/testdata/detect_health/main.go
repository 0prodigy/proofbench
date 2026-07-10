package main

import "net/http"

func main() {
	http.HandleFunc("/healthz", healthHandler)
	http.ListenAndServe(":8080", nil)
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
