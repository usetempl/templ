import type { WalletIdentification, WidgetWalletNetwork } from "@templ/chat/widget-wallet";
import { ui } from "./ui/ui";
import styles from "./wallet-identification-fields.module.css";

const families: readonly [WidgetWalletNetwork, string][] = [
  ["evm", "EVM (Ethereum and L2s)"],
  ["solana", "Solana"],
];

/** Native inputs preserve a first tap while the creation page loads its JavaScript. */
export function OnboardingWalletFields({ value, disabled }: { value: WalletIdentification; disabled: boolean }) {
  return (
    <fieldset className={styles.group} disabled={disabled} aria-label="Visitor wallet options">
      <label className={ui.check}>
        <input type="checkbox" name="visitorWallets" defaultChecked={value.enabled}
          onChange={event => {
            if (!event.currentTarget.checked) return;
            const form = event.currentTarget.form;
            for (const [family] of families) {
              const input = form?.elements.namedItem(family);
              if (input instanceof HTMLInputElement) input.checked = true;
            }
          }} />
        Let visitors verify a wallet in chat
      </label>
      <div className={styles.onboardingFamilies}>
        {families.map(([family, label]) => (
          <label className={ui.check} key={family}>
            <input type="checkbox" name={family} defaultChecked={value[family]} />{label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function WalletIdentificationFields({ value, disabled, onChange }: {
  value: WalletIdentification;
  disabled?: boolean;
  onChange(value: WalletIdentification): void;
}) {
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend>Wallet identification</legend>
      <label className={ui.check}>
        <input type="checkbox" checked={value.enabled}
          onChange={event => onChange({ ...value, enabled: event.target.checked })} />
        Let visitors verify a wallet in chat
      </label>
      <div className={styles.families}>
        {families.map(([family, label]) => (
          <label className={ui.check} key={family}>
            <input type="checkbox" disabled={!value.enabled} checked={value.enabled && value[family]}
              onChange={event => onChange({ ...value, [family]: event.target.checked })} />
            {label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
