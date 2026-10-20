import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { env } from '../../config/env';

/**
 * A plain-language privacy notice and terms for this beta. It is public (no sign-in) so people can read it before they
 * hand over a name and email. Keep it in step with what the app really sends: see supabase/functions/* and src/data.
 */
export function PrivacyScreen() {
  return (
    <main className="shared">
      <article className="shared-inner stack" style={{ gap: 20 }}>
        <div>
          <Link to="/" className="row small muted" style={{ textDecoration: 'none' }}>
            <ArrowLeft size={16} aria-hidden /> Back to NoteAI
          </Link>
        </div>
        <header className="stack" style={{ gap: 6 }}>
          <p className="eyebrow">NoteAI beta</p>
          <h1 className="h1 display">Privacy &amp; terms</h1>
          <p className="muted">Short and literal: this is exactly what the app stores and sends.</p>
        </header>

        <section className="card stack">
          <h2 className="h3">What stays on your device</h2>
          <ul className="note-list">
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>Your recordings (audio), transcripts, notes, action items and settings live in this browser’s storage on your device.</span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>
                Transcription runs in your browser. The speech model files are downloaded from this same website and kept in your browser, so your
                audio is never sent to a transcription service.
              </span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>Clearing your browser data, or using “Wipe this device” in the Trust center, deletes them. We cannot recover them.</span>
            </li>
          </ul>
        </section>

        <section className="card stack">
          <h2 className="h3">What is sent to our server</h2>
          <ul className="note-list">
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>
                <strong>When you sign in with an access code:</strong> the code (only a hash is stored), a random device identifier (hashed), a short
                description of your browser (for example “Chrome on Windows”), and the full name and email you type the first time a device uses a
                code. They are stored with the code so the organiser knows who is using it. They are not used to sign you in and are not sold or shared.
              </span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>
                <strong>Only if you press “Create link” in Share:</strong> a snapshot of that recording’s notes (title, summary, takeaways, decisions,
                chapters, action items). Never the audio and never the transcript. Anyone with the link can read the snapshot until it expires (1, 7
                or 30 days) or you revoke it.
              </span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>Your network address is hashed and used only to slow down repeated wrong-code attempts.</span>
            </li>
          </ul>
          <p className="small muted">
            The server is a Supabase project in Singapore. There are no advertising or analytics trackers, and fonts and the speech model are
            served from this site.
          </p>
        </section>

        {env.cloudAi && (
          <section className="card stack">
            <h2 className="h3">Only if you choose “Use cloud AI instead”</h2>
            <p>
              That button is optional and off by default. If you press it, the recording’s audio is uploaded to private storage on the server, sent to
              Groq (a third-party AI service) to be transcribed, and the transcript is sent to Groq again to write the notes. The audio and results stay
              on the server until you delete them (Trust center), and Groq processes them under its own terms. Do not use it for anything you would not
              want a third party to process. Without pressing it, none of this happens.
            </p>
          </section>
        )}

        <section className="card stack">
          <h2 className="h3">Your choices</h2>
          <p>
            Trust center → <em>Delete my account</em> removes your server sign-in record and every share link you made. <em>Wipe this device</em>{' '}
            removes everything stored in this browser. Ask the person who gave you the code to release or replace a code.
          </p>
        </section>

        <section className="card stack">
          <h2 className="h3">Terms of this beta</h2>
          <ul className="note-list">
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>NoteAI is a test version provided as is, without warranty. Transcripts and notes can contain mistakes: check anything important.</span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>You are responsible for telling people you record and getting their permission where the law or good practice requires it.</span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>It is a website, not an app: recording is not guaranteed to continue while the screen is off or the browser is in the background.</span>
            </li>
            <li className="note-item">
              <span className="bullet" aria-hidden />
              <span>Each code works on one device. Do not share your code.</span>
            </li>
          </ul>
        </section>
      </article>
    </main>
  );
}
