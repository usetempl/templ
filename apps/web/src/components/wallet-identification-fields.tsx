import type { WalletIdentification, WidgetWalletNetwork } from "@templ/chat/widget-wallet";
import { ui } from "./ui/ui";
import styles from "./wallet-identification-fields.module.css";

const families: readonly [WidgetWalletNetwork, string][] = [
  ["evm", "EVM (Ethereum and L2s)"],
  ["solana", "Solana"],
];

export function WalletIdentificationFields({ value, disabled, onChange, onboarding = false }: {
  value: WalletIdentification;
  disabled?: boolean;
  onboarding?: boolean;
  onChange(value: WalletIdentification): void;
}) {
  return (
    <fieldset className={styles.group} disabled={disabled} aria-label={onboarding ? "Visitor wallet options" : undefined}>
      {!onboarding && <legend>Wallet identification</legend>}
      <label className={ui.check}>
        <input type="checkbox" checked={value.enabled}
          onChange={event => onChange(onboarding && event.target.checked
            ? { enabled: true, evm: true, solana: true }
            : { ...value, enabled: event.target.checked })} />
        {onboarding ? "My users have crypto wallets" : "Let visitors verify a wallet in chat"}
      </label>
      {(!onboarding || value.enabled) && <div className={styles.families}>
        {families.map(([family, label]) => (
          <label className={ui.check} key={family}>
            <input type="checkbox" disabled={!value.enabled} checked={value.enabled && value[family]}
              onChange={event => onChange({ ...value, [family]: event.target.checked })} />
            {label}
          </label>
        ))}
      </div>}
    </fieldset>
  );
}
