package serve

import (
	"net/http"
	"runtime"
	"sync"
	"testing"
	"time"
)

// A hundred panes share one connection, each producing frames at once: every
// pane receives exactly its own frames, in order, none twice, and the metrics
// end with nothing owed. The per-pane budget a browser could never offer (one
// stream each) is the whole point of the multiplex, so the count is the test.
func TestMuxCarriesAHundredPanesOnOneConnection(t *testing.T) {
	if testing.Short() {
		t.Skip("soak")
	}
	const panes, frames = 100, 60
	_, rts, srv := muxHub(t, panes)
	c := openMux(t, srv)
	for _, rt := range rts {
		if code, body := c.call(http.MethodPut, rt.ID, ""); code != http.StatusNoContent {
			t.Fatalf("attach %s = %d %s", rt.ID, code, body)
		}
	}

	var wg sync.WaitGroup
	for _, rt := range rts {
		wg.Go(func() {
			for range frames {
				rt.Events.Emit(notice(rt.ID))
			}
		})
	}
	wg.Wait()

	got := map[string][]int64{}
	owed := panes * frames
	deadline := time.After(30 * time.Second)
	for owed > 0 {
		select {
		case f := <-c.frames:
			if f.Frame.Code == "" || f.Frame.Seq == 0 {
				continue
			}
			if f.Frame.Code != f.Pane {
				t.Fatalf("pane %s received a frame produced by %s", f.Pane, f.Frame.Code)
			}
			got[f.Pane] = append(got[f.Pane], f.Frame.Seq)
			owed--
		case <-deadline:
			t.Fatalf("%d of %d frames never arrived", owed, panes*frames)
		}
	}
	for pane, seqs := range got {
		if len(seqs) != frames {
			t.Fatalf("pane %s received %d frames, want %d", pane, len(seqs), frames)
		}
		for i := 1; i < len(seqs); i++ {
			if seqs[i] != seqs[i-1]+1 {
				t.Fatalf("pane %s frames out of order or repeated: %d then %d", pane, seqs[i-1], seqs[i])
			}
		}
	}

	m := readMuxMetrics(t, srv.URL, c.conn)
	if len(m.Panes) != panes {
		t.Fatalf("metrics list %d panes, want %d", len(m.Panes), panes)
	}
	for _, p := range m.Panes {
		if p.Behind != 0 || p.Sent < frames {
			t.Fatalf("pane %s ends behind: %+v", p.Pane, p)
		}
	}
}

// Tearing the connection down after a hundred panes leaves no goroutine and no
// subscriber behind.
func TestMuxHundredPaneTeardownLeavesNothingRunning(t *testing.T) {
	if testing.Short() {
		t.Skip("soak")
	}
	_, rts, srv := muxHub(t, 100)
	before, base := runtime.NumGoroutine(), 0
	for _, rt := range rts {
		base += rt.Events.Subscribers()
	}
	c := openMux(t, srv)
	for _, rt := range rts {
		c.call(http.MethodPut, rt.ID, "")
	}
	c.cancel()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		subscribed := 0
		for _, rt := range rts {
			subscribed += rt.Events.Subscribers()
		}
		if subscribed == base && runtime.NumGoroutine() <= before+4 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("after teardown: goroutines %d (before %d)", runtime.NumGoroutine(), before)
}
