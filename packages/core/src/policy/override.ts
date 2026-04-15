/**
 * Check whether a Linear issue carries the configured override label.
 * Case-insensitive match.
 *
 * SECURITY NOTE: This bypass relies on Linear label creation being restricted
 * to authorized team members. Operators should ensure that the configured
 * override label (default "policy-override") can only be created and applied
 * by principals trusted to bypass policy gates. In permissive Linear
 * workspaces, consider using a label name that's less likely to be created
 * accidentally, or disable the override mechanism entirely by setting
 * `overrideLabel` to a sentinel value that no one will use.
 *
 * Uses Linear SDK lazy-relation method pattern — `.labels` is a method,
 * not a property.
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
