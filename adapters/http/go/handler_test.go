package testbench

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAuthenticatedDispatch(t *testing.T) {
	calls := 0
	handler := Handler(strings.Repeat("a", 64), func(ctx context.Context, raw json.RawMessage) (any, error) {
		calls++
		return map[string]any{"type": 4, "data": map[string]string{"content": "Go response"}}, nil
	})
	for _, authenticated := range []bool{false, true} {
		request := httptest.NewRequest("POST", "/testbench", strings.NewReader(`{"type":2}`))
		if authenticated {
			request.Header.Set("Authorization", "Bearer "+strings.Repeat("a", 64))
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if authenticated && response.Code != 200 || !authenticated && response.Code != 401 {
			t.Fatalf("unexpected response status %d", response.Code)
		}
	}
	if calls != 1 {
		t.Fatalf("expected one authorized dispatch, got %d", calls)
	}
}
