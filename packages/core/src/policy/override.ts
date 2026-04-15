/**
 * Check whether a Linear issue carries the configured override label.
 * Case-insensitive match. Uses Linear SDK lazy-relation method pattern —
 * `.labels` is a method, not a property.
 */
export async function hasOverrideLabel(
  issue: { labels: () => Promise<{ nodes: Array<{ name: string }> }> },
  labelName: string,
): Promise<boolean> {
  try {
    const labels = await issue.labels();
    const target = labelName.toLowerCase();
    return labels.nodes.some((l) => l.name.toLowerCase() === target);
  } catch {
    return false;
  }
}
