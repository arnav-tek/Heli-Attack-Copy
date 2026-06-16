import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean; message: string };

/**
 * Catches render/runtime errors in the game tree and shows a recoverable
 * fallback instead of a blank screen (e.g. WebGL context loss, asset errors).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message ?? 'Unknown error' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Heli-Strike crashed:', error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[#102447] px-6 text-center text-white">
        <h1 className="text-3xl font-black uppercase tracking-[0.16em] text-[#ff3344]">
          Mission Aborted
        </h1>
        <p className="max-w-md text-sm font-semibold text-white/80">
          The game hit an unexpected error and had to stop. Reloading usually fixes it.
        </p>
        <code className="max-w-md break-words rounded-[6px] border border-white/20 bg-black/30 px-3 py-2 text-xs text-white/60">
          {this.state.message}
        </code>
        <button
          type="button"
          onClick={this.handleReload}
          className="h-12 min-w-44 rounded-[7px] border-2 border-white/75 bg-[#ff3344] px-6 text-lg font-black uppercase tracking-[0.16em] text-white shadow-[0_6px_0_#931521] transition hover:-translate-y-0.5 hover:bg-[#ff4b59] active:translate-y-1"
        >
          Reload
        </button>
      </div>
    );
  }
}

/** Returns true when the browser can create a WebGL rendering context. */
export function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(
      window.WebGLRenderingContext &&
      (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
    );
  } catch {
    return false;
  }
}

export function WebGLUnsupported() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[#102447] px-6 text-center text-white">
      <h1 className="text-3xl font-black uppercase tracking-[0.16em] text-[#ffe66d]">
        WebGL Required
      </h1>
      <p className="max-w-md text-sm font-semibold text-white/80">
        Heli-Strike needs WebGL to render its 3D world. Enable hardware acceleration in your
        browser settings or try a modern browser like Chrome, Edge, or Firefox.
      </p>
    </div>
  );
}
