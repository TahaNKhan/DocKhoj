import { Route, Switch, Redirect } from 'wouter-preact';
import { TopBar } from './components/TopBar';
import { Chat } from './routes/Chat';
import { Upload } from './routes/Upload';

// App — the chrome (background layers + TopBar) wraps the route content.
// Background layers are painted here so they sit behind both /chat and
// /upload consistently. Routes use wouter-preact; / redirects to /chat.

export function App() {
  return (
    <>
      <div class="aurora" aria-hidden="true" />
      <div class="grain" aria-hidden="true" />
      <div class="grid-overlay" aria-hidden="true" />

      <TopBar />

      <main>
        <Switch>
          <Route path="/">
            <Redirect to="/chat" />
          </Route>
          <Route path="/chat">
            <Chat />
          </Route>
          <Route path="/upload">
            <Upload />
          </Route>
        </Switch>
      </main>
    </>
  );
}