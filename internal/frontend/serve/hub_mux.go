package serve

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// muxWriteTimeout bounds one write to a muxed client. A client that stops
// reading ends its own connection and takes only its own subscriptions with it.
const muxWriteTimeout = 30 * time.Second

const (
	codeMuxUnknownConn = "mux.unknown_connection"
	codeMuxNotLocal    = "mux.pane_not_local"
)

// eventMuxes tracks the open multiplexed streams of one hub. A browser origin
// holds a handful of connections over HTTP/1.1, so a window that gives every
// pane its own stream starves its own requests; one stream carrying every
// pane's frames, each in an envelope naming its pane, costs one connection.
type eventMuxes struct {
	mu    sync.Mutex
	conns map[string]*muxConn
}

func newEventMuxes() *eventMuxes { return &eventMuxes{conns: map[string]*muxConn{}} }

// muxOpened is the first data frame of a stream: the id every subscription
// call names.
type muxOpened struct {
	Kind string `json:"kind"`
	Conn string `json:"conn"`
}

// muxAttachRequest is a pane's resume point. Absent means the client holds
// nothing of that pane yet.
type muxAttachRequest struct {
	After *int64 `json:"after"`
}

// muxEnvelopeView is one pane's frame on the shared stream, the frame carried
// byte for byte as the pane's own /events would have sent it.
type muxEnvelopeView struct {
	Pane  string          `json:"pane"`
	Frame json.RawMessage `json:"frame"`
}

// muxConn is one open stream. Its subscriptions live and die with it.
type muxConn struct {
	id   string
	wake chan struct{}

	mu    sync.Mutex
	panes map[string]*muxPane
	order []string
	notes [][]byte
	done  bool
}

// muxPane is one pane's subscription on a connection. slot holds at most the
// one frame the writer has not yet taken, so a slow client backs up into the
// pane's own subscriber queue, where the shedding rules already live.
type muxPane struct {
	id          string
	slot        chan Frame
	unsubscribe func()
	stop        chan struct{}
	bc          *Broadcaster
	sent        atomic.Int64
	lastSeq     atomic.Int64
}

func (m *eventMuxes) open() *muxConn {
	var raw [16]byte
	_, _ = rand.Read(raw[:])
	c := &muxConn{id: hex.EncodeToString(raw[:]), wake: make(chan struct{}, 1), panes: map[string]*muxPane{}}
	m.mu.Lock()
	m.conns[c.id] = c
	m.mu.Unlock()
	return c
}

func (m *eventMuxes) get(id string) *muxConn {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conns[id]
}

func (m *eventMuxes) remove(c *muxConn) {
	m.mu.Lock()
	delete(m.conns, c.id)
	m.mu.Unlock()
	c.shutdown()
}

// paneClosed tells every connection holding the pane that it is gone.
func (m *eventMuxes) paneClosed(pane string) {
	m.mu.Lock()
	conns := make([]*muxConn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	m.mu.Unlock()
	for _, c := range conns {
		if c.drop(pane) {
			c.note(muxEnvelope(pane, `{"kind":"mux_pane_closed"}`))
		}
	}
}

func muxEnvelope(pane string, frame string) []byte {
	data, _ := json.Marshal(muxEnvelopeView{Pane: pane, Frame: json.RawMessage(frame)})
	return data
}

func (c *muxConn) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *muxConn) note(data []byte) {
	c.mu.Lock()
	if !c.done {
		c.notes = append(c.notes, data)
	}
	c.mu.Unlock()
	c.signal()
}

// attach replaces the pane's subscription: the old subscriber is unregistered
// before the new one is registered, so one pane never feeds a connection twice.
func (c *muxConn) attach(srv *Server, pane string, after int64, first bool) bool {
	c.drop(pane)
	ch, unsub := srv.subscribeEvents(after, first)
	p := &muxPane{id: pane, slot: make(chan Frame, 1), unsubscribe: unsub, stop: make(chan struct{}), bc: srv.bc}
	c.mu.Lock()
	if c.done {
		c.mu.Unlock()
		unsub()
		return false
	}
	c.panes[pane] = p
	c.order = append(c.order, pane)
	c.mu.Unlock()
	go func() {
		for f := range ch {
			select {
			case p.slot <- f:
				c.signal()
			case <-p.stop:
				return
			}
		}
	}()
	return true
}

func (c *muxConn) drop(pane string) bool {
	c.mu.Lock()
	p := c.panes[pane]
	if p != nil {
		delete(c.panes, pane)
		c.order = removeString(c.order, pane)
	}
	c.mu.Unlock()
	if p == nil {
		return false
	}
	close(p.stop)
	p.unsubscribe()
	return true
}

func (c *muxConn) shutdown() {
	c.mu.Lock()
	c.done = true
	ids := append([]string(nil), c.order...)
	c.mu.Unlock()
	for _, id := range ids {
		c.drop(id)
	}
}

// next hands out one frame, rotating through the panes so a busy one cannot
// starve a quiet one.
func (c *muxConn) next(cursor *int) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.notes) > 0 {
		n := c.notes[0]
		c.notes = c.notes[1:]
		return n, true
	}
	for i := range len(c.order) {
		idx := (*cursor + i) % len(c.order)
		p := c.panes[c.order[idx]]
		select {
		case f := <-p.slot:
			*cursor = idx + 1
			p.sent.Add(1)
			p.lastSeq.Store(f.Seq)
			return muxEnvelope(p.id, string(f.Data)), true
		default:
		}
	}
	return nil, false
}

func (c *muxConn) watermarks() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([][]byte, 0, len(c.order))
	for _, id := range c.order {
		out = append(out, muxEnvelope(id, fmt.Sprintf(`{"kind":"stream_watermark","seq":%d}`, c.panes[id].bc.Watermark())))
	}
	return out
}

// muxPaneMetrics is one pane's delivery on a connection. Behind is how many
// frames the pane has numbered that this connection has not yet written: zero
// is a pane that is idle or caught up, and a count that does not fall is a pane
// that has stopped being delivered.
type muxPaneMetrics struct {
	Pane      string `json:"pane"`
	Sent      int64  `json:"sent"`
	LastSeq   int64  `json:"last_seq"`
	Watermark int64  `json:"watermark"`
	Behind    int64  `json:"behind"`
}

type muxMetrics struct {
	Conn  string           `json:"conn"`
	Panes []muxPaneMetrics `json:"panes"`
}

func (c *muxConn) metrics() muxMetrics {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := muxMetrics{Conn: c.id, Panes: make([]muxPaneMetrics, 0, len(c.order))}
	for _, id := range c.order {
		p := c.panes[id]
		last, mark := p.lastSeq.Load(), p.bc.Watermark()
		out.Panes = append(out.Panes, muxPaneMetrics{Pane: id, Sent: p.sent.Load(), LastSeq: last, Watermark: mark, Behind: max(mark-last, 0)})
	}
	return out
}

func (h *Hub) muxMetrics(w http.ResponseWriter, r *http.Request) {
	c := h.muxes.get(r.PathValue("conn"))
	if c == nil {
		refuse(w, http.StatusNotFound, codeMuxUnknownConn, "this stream is not open; open a new one and subscribe again", nil)
		return
	}
	writeJSON(w, c.metrics())
}

func (h *Hub) registerMuxRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /events/mux/{conn}/metrics", h.muxMetrics)
	mux.HandleFunc("GET /events/mux", h.muxStream)
	mux.HandleFunc("PUT /events/mux/{conn}/panes/{id}", h.muxAttach)
	mux.HandleFunc("DELETE /events/mux/{conn}/panes/{id}", h.muxDetach)
}

func (h *Hub) muxStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		refuse(w, http.StatusInternalServerError, "stream.unsupported", "this transport cannot stream", nil)
		return
	}
	c := h.muxes.open()
	defer h.muxes.remove(c)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	rc := http.NewResponseController(w)
	write := func(format string, args ...any) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(muxWriteTimeout))
		if _, err := fmt.Fprintf(w, format, args...); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	opened, _ := json.Marshal(muxOpened{Kind: "mux_open", Conn: c.id})
	if !write(": connected\n\ndata: %s\n\n", opened) {
		return
	}
	keepalive := time.NewTicker(sseKeepaliveInterval)
	defer keepalive.Stop()
	cursor := 0
	for {
		for {
			data, ok := c.next(&cursor)
			if !ok {
				break
			}
			if !write("data: %s\n\n", data) {
				return
			}
		}
		select {
		case <-c.wake:
		case <-keepalive.C:
			if !write(": ping\n\n") {
				return
			}
			for _, m := range c.watermarks() {
				if !write("data: %s\n\n", m) {
					return
				}
			}
		case <-r.Context().Done():
			return
		}
	}
}

func (h *Hub) muxAttach(w http.ResponseWriter, r *http.Request) {
	c := h.muxes.get(r.PathValue("conn"))
	if c == nil {
		refuse(w, http.StatusNotFound, codeMuxUnknownConn, "this stream is not open; open a new one and subscribe again", nil)
		return
	}
	var body muxAttachRequest
	if r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			badBody(w)
			return
		}
	}
	id := r.PathValue("id")
	rt := h.Get(id)
	if rt == nil {
		notFound(w, "runtime", id)
		return
	}
	if !rt.Local() {
		refuse(w, http.StatusConflict, codeMuxNotLocal, "this pane is driven from another machine and keeps its own stream", nil)
		return
	}
	after := int64(0)
	if body.After != nil && *body.After > 0 {
		after = *body.After
	}
	if !c.attach(rt.Server, id, after, body.After == nil) {
		refuse(w, http.StatusNotFound, codeMuxUnknownConn, "this stream has closed; open a new one and subscribe again", nil)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Hub) muxDetach(w http.ResponseWriter, r *http.Request) {
	c := h.muxes.get(r.PathValue("conn"))
	if c == nil {
		refuse(w, http.StatusNotFound, codeMuxUnknownConn, "this stream is not open; open a new one and subscribe again", nil)
		return
	}
	c.drop(strings.TrimSpace(r.PathValue("id")))
	w.WriteHeader(http.StatusNoContent)
}
