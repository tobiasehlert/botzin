export interface SectionTab {
  readonly id: string;
  readonly label: string;
}

interface Props {
  tabs: readonly SectionTab[];
  active: string;
  onSelect: (id: string) => void;
  label: string;
}

/**
 * Sub-navigation inside a page. Panels stay mounted and are hidden with the
 * `hidden` attribute instead of being unmounted, so a half-filled form survives
 * an accidental tab click.
 */
export function SectionNav({ tabs, active, onSelect, label }: Props) {
  return (
    <nav className="section-tabs" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onSelect(tab.id)}
          className={`section-tab${tab.id === active ? " is-active" : ""}`}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
