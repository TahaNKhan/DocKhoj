import { useState } from 'preact/hooks';
import { Sidebar } from '../components/Sidebar';
import { Bubble } from '../components/Bubble';
import { Composer } from '../components/Composer';

// Chat route — sidebar + chat area (toolbar + stream + composer).
// T25 ships with a static conversation that matches the mockup seed.
// T30 wires the sidebar to /api/sessions; T33/T34 wire the SSE stream.

export function Chat() {
  const [activeSession, setActiveSession] = useState('s1');

  return (
    <div class="chat-shell">
      <Sidebar
        activeId={activeSession}
        onSelect={setActiveSession}
        onCreate={() => {
          /* T30 wires to POST /api/sessions */
        }}
      />

      <div class="area">
        <div class="toolbar">
          <div class="crumb">
            Session <i>/</i> <b>Habit loop notes</b>
          </div>
          <div class="model">
            <span class="sw" />
            <span>llama-3.1 · 8k ctx</span>
            <span class="car">▾</span>
          </div>
        </div>

        <div class="stream">
          <Bubble
            role="user"
            text="What did I read about habit loops last week?"
            timestamp="10:42"
          />
          <Bubble
            role="assistant"
            timestamp="10:42"
            text={`Three of your notes touched the cue–routine–reward loop. The strongest framing came from notes-on-habits.md — you wrote that "the cue is invisible until you name it." A second pass in garden-logbook.txt applied the loop to watering cadence, and a paper excerpt in attention-is-all-you-need.pdf (footnote 3) used the same model as a metaphor for attention selection.`}
            sources={[
              { id: 'src1', number: 1, fileName: 'notes-on-habits.md', page: 'p.2' },
              { id: 'src2', number: 2, fileName: 'garden-logbook.txt', page: '04-12' },
              { id: 'src3', number: 3, fileName: 'attention-is-all-you-need.pdf', page: 'fn 3' },
            ]}
          />
          <Bubble
            role="user"
            text="Pull the cue half — what did I actually write?"
            timestamp="10:43"
          />
          <Bubble
            role="assistant"
            timestamp="10:43"
            text={`From notes-on-habits.md, p.2: "The cue is invisible until you name it — that's the whole trick. Last Tuesday I noticed the urge to open Twitter right after the kettle clicked. The kettle was the cue. Naming it broke about 80% of the loop in one go." There's a follow-up on p.4 about pairing the cue with a 30-second pause.`}
            sources={[
              { id: 'src4', number: 1, fileName: 'notes-on-habits.md', page: 'p.2, p.4' },
            ]}
            followups={[
              { id: 'fu1', text: 'Pull the routine half too' },
              { id: 'fu2', text: 'Show everything tagged habit' },
              { id: 'fu3', text: "What's the citation depth on this claim?" },
            ]}
          />
        </div>

        <Composer
          onSubmit={(text) => {
            /* T34 wires to POST /api/chat/stream */
            console.log('chat submit (stub):', text);
          }}
        />
      </div>
    </div>
  );
}