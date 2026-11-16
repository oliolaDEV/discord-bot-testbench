package testbench

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"
)

type Dispatcher func(context.Context, json.RawMessage) (any, error)

func Handler(secret string, dispatch Dispatcher) http.Handler {
	if len(secret) < 32 {
		panic("testbench secret must contain at least 32 characters")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
			http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodPost || r.Header.Get("Origin") != "" {
			http.Error(w, `{"error":"Unsupported request"}`, http.StatusForbidden)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1048576))
		if err != nil || !json.Valid(body) {
			http.Error(w, `{"error":"Invalid body"}`, http.StatusBadRequest)
			return
		}
		result, err := dispatch(r.Context(), body)
		if err != nil {
			http.Error(w, `{"error":"Handler failed"}`, http.StatusInternalServerError)
			return
		}
		json.NewEncoder(w).Encode(result)
	})
}
