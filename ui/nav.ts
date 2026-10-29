export function navigate(url: string): void {
  history.pushState(null, '', url);
  dispatchEvent(new PopStateEvent('popstate'));
}
