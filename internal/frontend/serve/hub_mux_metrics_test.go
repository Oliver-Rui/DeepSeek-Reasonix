package serve

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

type muxMetricsBody struct {
	Conn  string `json:"conn"`
	Panes []struct {
		Pane      string `json:"pane"`
		Sent      int64  `json:"sent"`
		LastSeq   int64  `json:"last_seq"`
		Watermark int64  `json:"watermark"`
		Behind    int64  `json:"behind"`
	} `json:"panes"`
}

func readMuxMetrics(t *testing.T, base, conn string) muxMetricsBody {
	t.Helper()
	resp, err := http.Get(base + "/events/mux/" + conn + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("metrics = %d", resp.StatusCode)
	}
	var out muxMetricsBody
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A pane that stopped receiving shows as behind, with the exact count of frames
// it is owed, while a pane the client has read to the end shows zero. That is
// the number that tells a frozen pane from an idle one.
func TestMuxMetricsSayWhichPaneIsBehindAndByHowMany(t *testing.T) {
	h, rts, srv := muxHub(t, 2)
	idle, stalled := rts[0], rts[1]

	reader := openMux(t, srv)
	reader.call(http.MethodPut, idle.ID, "")
	idle.Events.Emit(notice("one"))
	idle.Events.Emit(notice("two"))
	for got := 0; got < 2; {
		if f := reader.next(); f.Frame.Code != "" && f.Frame.Seq > 0 {
			got++
		}
	}

	c := h.muxes.open()
	defer h.muxes.remove(c)
	if !c.attach(stalled.Server, stalled.ID, stalled.Events.Watermark(), false) {
		t.Fatal("attach refused")
	}
	for range 5 {
		stalled.Events.Emit(notice("owed"))
	}

	deadline := time.Now().Add(3 * time.Second)
	var m muxMetricsBody
	for time.Now().Before(deadline) {
		m = readMuxMetrics(t, srv.URL, reader.conn)
		if len(m.Panes) == 1 && m.Panes[0].Behind == 0 && m.Panes[0].Sent >= 2 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if m.Conn != reader.conn || len(m.Panes) != 1 || m.Panes[0].Pane != idle.ID || m.Panes[0].Behind != 0 || m.Panes[0].LastSeq != m.Panes[0].Watermark {
		t.Fatalf("a read-to-the-end pane reads %+v", m)
	}

	owed := c.metrics()
	if len(owed.Panes) != 1 || owed.Panes[0].Behind != 5 || owed.Panes[0].Sent != 0 {
		t.Fatalf("a pane nobody reads reads %+v, want 5 behind and nothing sent", owed)
	}
}

func TestMuxMetricsRefuseAnUnknownConnectionWithItsCode(t *testing.T) {
	_, _, srv := muxHub(t, 1)
	resp, err := http.Get(srv.URL + "/events/mux/" + "00000000000000000000000000000000" + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	if got := muxRefusalCode(t, resp); got != codeMuxUnknownConn {
		t.Fatalf("code = %q", got)
	}
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func muxRefusalCode(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	var body struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return body.Code
}
