import { Compass } from 'lucide-react';
import { EmptyState, LinkButton } from '../components/primitives';

export function NotFoundScreen() {
  return (
    <div className="page">
      <EmptyState
        icon={<Compass />}
        title="Page not found"
        action={
          <LinkButton to="/" variant="primary">
            Go home
          </LinkButton>
        }
      >
        That page doesn’t exist. Your recordings are safe.
      </EmptyState>
    </div>
  );
}
