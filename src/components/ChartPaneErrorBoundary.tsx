import { Component, type ErrorInfo, type ReactNode } from "react";

interface ChartPaneErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface ChartPaneErrorBoundaryState {
  error: Error | null;
  retryCount: number;
}

export class ChartPaneErrorBoundary extends Component<ChartPaneErrorBoundaryProps, ChartPaneErrorBoundaryState> {
  state: ChartPaneErrorBoundaryState = { error: null, retryCount: 0 };
  private retryFrame: number | null = null;

  static getDerivedStateFromError(error: Error): Partial<ChartPaneErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Chart pane failed to initialize.", error, info);
    if (this.state.retryCount > 0 || this.retryFrame != null) return;
    this.retryFrame = requestAnimationFrame(() => {
      this.retryFrame = null;
      this.setState({ error: null, retryCount: 1 });
    });
  }

  componentDidUpdate(previous: ChartPaneErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, retryCount: 0 });
    }
  }

  componentWillUnmount() {
    if (this.retryFrame != null) cancelAnimationFrame(this.retryFrame);
  }

  private retry = () => {
    this.setState({ error: null, retryCount: 0 });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return <section className="chart-pane-error" role="alert">
      <strong>Chart could not initialize</strong>
      <span>The workspace is still available. Retry this pane.</span>
      <button type="button" onClick={this.retry}>Retry chart</button>
    </section>;
  }
}
