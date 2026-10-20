import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { PrivacyScreen } from './screens/PrivacyScreen';

describe('Privacy & terms', () => {
  it('states what stays on the device and exactly what is sent to the server', () => {
    render(
      <MemoryRouter>
        <PrivacyScreen />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /privacy & terms/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /what stays on your device/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /what is sent to our server/i })).toBeInTheDocument();
    expect(screen.getByText(/never the audio and never the transcript/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to noteai/i })).toBeInTheDocument();
  });
});
