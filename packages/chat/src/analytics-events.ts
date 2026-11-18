/** Every browser event and its one fixed source, in onboarding order. The app
 * adapter and the bridge script both accept exactly these pairs. */
export const ANALYTICS_SOURCES = {
  onboarding_viewed: "onboarding",
  create_viewed: "create",
  create_failed: "create",
  sign_in_failed: "account",
  sign_in_cancelled: "account",
  workspace_home_viewed: "workspace",
  widget_settings_viewed: "workspace",
  team_viewed: "workspace",
  brain_viewed: "workspace",
  brain_source_added: "workspace",
  brain_setup_failed: "workspace",
  ai_settings_saved: "workspace",
  ai_settings_failed: "workspace",
  plan_viewed: "workspace",
  install_check_completed: "workspace",
  landing_view: "landing",
  prompt_copied: "landing",
  install_prompt_clicked: "landing",
  pilot_clicked: "landing",
  billing_rules_clicked: "landing",
  create_clicked: "landing",
  talk_to_us_clicked: "landing",
  app_access_requested: "landing",
  pricing_rules_clicked: "landing",
  blog_case_arrives_ready_install_opened: "blog",
  blog_connected_wallet_is_not_proof_install_opened: "blog",
  blog_what_a_transaction_check_tells_you_install_opened: "blog",
  blog_pay_per_resolved_case_install_opened: "blog",
  blog_fake_crypto_support_install_opened: "blog",
  blog_install_support_with_one_prompt_install_opened: "blog",
  blog_solana_transaction_failed_install_opened: "blog",
  blog_choose_crypto_support_software_install_opened: "blog",
  blog_measure_your_support_pilot_install_opened: "blog",
  widget_prompt_used: "landing",
  widget_lead_email: "landing",
  widget_lead_wallet: "landing",
  widget_lead_qualified: "landing",
  example_vault_view: "example",
  example_network_changed: "example",
  example_scenario_changed: "example",
  example_deposit_clicked: "example",
  example_withdraw_clicked: "example",
  example_support_opened: "example",
  example_support_failed: "example",
  hosted_support_opened: "support",
  hosted_support_failed: "support",
  hosted_support_network_changed: "support",
  sign_in_opened: "account",
  sign_in_wallet_connect_clicked: "account",
  sign_in_verify_clicked: "account",
  sign_in_completed: "account",
  connect_opened: "onboarding",
  connect_sign_in_clicked: "onboarding",
  connect_create_selected: "onboarding",
  connect_workspace_selected: "onboarding",
  connect_confirm_clicked: "onboarding",
  connect_completed: "onboarding",
  connect_cancel_clicked: "onboarding",
  connect_cancelled: "onboarding",
  connect_failed: "onboarding",
  create_submitted: "create",
  create_completed: "create",
  setup_site_clicked: "workspace",
  setup_snippet_clicked: "workspace",
  setup_team_clicked: "workspace",
  team_invite_create_clicked: "workspace",
  team_invite_created: "workspace",
  team_invite_revoke_clicked: "workspace",
  team_invite_revoked: "workspace",
  team_invite_accept_clicked: "workspace",
  team_invite_accepted: "workspace",
  team_invite_failed: "workspace",
  setup_priorities_clicked: "workspace",
  install_check_started: "workspace",
  install_check_failed: "workspace",
  widget_site_approved: "workspace",
  widget_hosted_page_saved: "workspace",
  widget_person_control_saved: "workspace",
  widget_wallet_fallback_saved: "workspace",
  widget_journey_settings_failed: "workspace",
  widget_intro_saved: "workspace",
  widget_intro_failed: "workspace",
  widget_appearance_changed: "workspace",
  widget_preview_failed: "workspace",
  widget_snippet_copied: "workspace",
  workspace_prompt_copied: "workspace",
  checkout_started: "billing",
  payment_sent: "billing",
  payment_detail_copied: "billing",
  payment_hash_submitted: "billing",
  payment_check_clicked: "billing",
  payment_failed: "billing",
  payment_confirmed: "billing",
  card_setup_clicked: "billing",
  card_setup_opened: "billing",
  card_portal_clicked: "billing",
  card_portal_opened: "billing",
  usdc_prepay_clicked: "billing",
  usdc_prepay_requested: "billing",
} as const;
export type AnalyticsEvent = keyof typeof ANALYTICS_SOURCES;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[AnalyticsEvent];

const BLOG_INSTALL_EVENTS = {
  "case-arrives-ready": "blog_case_arrives_ready_install_opened",
  "connected-wallet-is-not-proof":
    "blog_connected_wallet_is_not_proof_install_opened",
  "what-a-transaction-check-tells-you":
    "blog_what_a_transaction_check_tells_you_install_opened",
  "pay-per-resolved-case": "blog_pay_per_resolved_case_install_opened",
  "fake-crypto-support": "blog_fake_crypto_support_install_opened",
  "install-support-with-one-prompt":
    "blog_install_support_with_one_prompt_install_opened",
  "solana-transaction-failed": "blog_solana_transaction_failed_install_opened",
  "choose-crypto-support-software":
    "blog_choose_crypto_support_software_install_opened",
  "measure-your-support-pilot":
    "blog_measure_your_support_pilot_install_opened",
} as const satisfies Record<string, AnalyticsEvent>;

/** A published guide selects one fixed event. Query values are never sent. */
export function blogInstallEvent(search: string): AnalyticsEvent | undefined {
  const params = new URLSearchParams(search);
  if (params.getAll("from").length !== 1 || params.get("from") !== "blog")
    return;
  if (
    params.getAll("guide").length !== 1 ||
    [...params.keys()].some((key) => key !== "from" && key !== "guide")
  )
    return;
  const guide = params.get("guide") ?? "";
  if (!Object.prototype.hasOwnProperty.call(BLOG_INSTALL_EVENTS, guide)) return;
  return BLOG_INSTALL_EVENTS[guide as keyof typeof BLOG_INSTALL_EVENTS];
}
