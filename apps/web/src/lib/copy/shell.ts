/** Site header, workspace creation, sign-in and account (shell.*). */
export const shell = {
  "shell.skipToContent": "Skip to content",
  // Labels several shell components share
  "shell.common.tryAgain": "Try again",
  "shell.common.signIn": "Sign in",
  "shell.common.cancel": "Cancel",
  "shell.common.remove": "Remove",
  "shell.common.keepIt": "Keep it",
  "shell.common.terms": "Terms",
  "shell.common.privacy": "Privacy",
  "shell.common.email": "Email",
  "shell.common.wallets": "Wallets",
  "shell.common.signInMethods": "Wallets and email",
  "shell.common.changeEmail": "Change email",
  "shell.common.resendCode": "Resend code",
  "shell.common.resendIn": "Resend in {seconds}s",
  "shell.common.codeSentTo": "Code sent to {email}",
  "shell.common.smartWallet": "Smart wallet",
  "shell.common.added": "Added {date}",
  "shell.common.accountChanged": "Your account changed. Try again.",
  // NativeChatCreate
  "shell.create.title": "Set up support",
  "shell.create.unavailable": "Workspace creation isn’t available yet.",
  "shell.create.failed": "Couldn’t create the workspace. Try again.",
  "shell.create.name": "App name",
  "shell.create.creating": "Creating…",
  "shell.create.retry": "Retry creating",
  // TokenImageCrop
  "shell.crop.title": "Frame your image",
  "shell.crop.hint": "Drag to reposition. The circle shows your profile image.",
  "shell.crop.openFailed": "Could not open this image. Choose another file.",
  "shell.crop.displayFailed":
    "Could not display this image. Choose another file.",
  "shell.crop.saveFailed": "Could not save this image.",
  "shell.crop.position": "Image position",
  "shell.crop.preview": "Image crop preview",
  "shell.crop.unavailable": "Image unavailable",
  "shell.crop.opening": "Opening image",
  "shell.crop.keyboard":
    "Use arrow keys to move the image. Hold Shift for larger steps.",
  "shell.crop.zoom": "Zoom",
  "shell.crop.zoomValue": "{percent} percent",
  "shell.crop.reset": "Reset",
  "shell.crop.preparing": "Preparing…",
  "shell.crop.use": "Use image",
  // SignInDialog (lib/chat-auth.tsx)
  "shell.signIn.title": "Sign in",
  "shell.signIn.close": "Close sign-in",
  "shell.signIn.methodsCheckFailed": "Other sign-in options could not load.",
  "shell.signIn.methodsUnavailable":
    "No sign-in method is available right now.",
  "shell.signIn.withWallet": "Continue with a wallet",
  "shell.signIn.withSolana": "Continue with a Solana wallet",
  // TemplSupport: Templ's own widget signing in with the Solana session wallet
  "shell.support.solanaSwitch":
    "Switch your wallet to {address}, the Solana account you signed in to Templ with, then try again.",
  "shell.support.solanaUnchecked":
    "Templ couldn’t check this sign-in request, so it didn’t ask your wallet to sign. Close support and open it again.",
  // ChatSkeleton (loading-state)
  "shell.loading.chat": "Loading chat",
  "shell.loading.workspaces": "Opening your workspaces",
  "shell.loading.workspace": "Opening workspace",
  "shell.loading.inbox": "Opening your inbox",
  "shell.loading.cases": "Loading cases",
  "shell.inbox.emptyOpen": "No open cases.",
  "shell.inbox.emptyNeedsYou": "Nothing needs you.",
  "shell.inbox.emptyFiltered": "No cases match these filters.",
  "shell.inbox.emptyView": "No cases in this view.",
  "shell.inbox.emptyAi": "The AI agent has no cases to answer.",
  "shell.inbox.emptyWaiting": "No cases are waiting on a user.",
  "shell.inbox.emptyResolved": "No resolved cases.",
  "shell.inbox.emptyNeedsReply": "No cases need a reply.",
  "shell.inbox.emptyNeedsPerson": "No cases need a person.",
  "shell.inbox.clearFilters": "Clear filters",
  "shell.setup.complete": "You're set up.",
  // NotFound
  "shell.notFound.title": "Page not found",
  "shell.notFound.hint": "Check the address or return to the home page.",
  "shell.notFound.back": "Back to Templ",
  // ErrorPage
  "shell.error.title": "Connection problem",
  "shell.error.hint":
    "This page didn’t load. Check your connection and try again.",
  // SettingsPage
  "shell.settings.title": "Settings",
  "shell.settings.signInMethodsHint":
    "Manage the wallets that sign in to your account and your alert email.",
  // AccountMethodsPage (the *Notice keys mirror the exported constants)
  "shell.account.title": "Wallets and email",
  "shell.account.lead":
    "Each wallet here signs in to this account. Keep at least one.",
  "shell.account.gate": "Sign in to see the wallets on your account.",
  "shell.account.idTitle": "Your account ID",
  "shell.account.idHint":
    "Share it with your protocol's manager to join the support team.",
  "shell.account.copyId": "Copy account ID",
  "shell.account.idCopied": "Account ID copied.",
  "shell.account.copyFailed": "Select and copy the account ID above.",
  "shell.account.emailFailed": "That didn’t work. Try again.",
  "shell.account.emailAdded": "Email added.",
  "shell.account.walletAdded": "Wallet added.",
  "shell.account.walletRemoved": "Wallet removed.",
  "shell.account.emailRemoved": "Email removed.",
  "shell.account.alertEmail": "Alert email",
  "shell.account.alertEmailHint":
    "Get support alerts at one address. It can’t sign in.",
  "shell.account.alertEmailUnavailable": "Email alerts aren’t available yet.",
  "shell.account.removeEmail": "Remove email",
  "shell.account.emailRemoveNotice":
    "You’ll stop getting support alerts by email.",
  "shell.account.verifyEmail": "Verify email",
  "shell.account.sendCode": "Send code",
  "shell.account.addEmail": "Add an email",
  "shell.account.walletsHint":
    "Add up to {count} wallets to sign in to this account. Each wallet signs a message to prove you control it.",
  "shell.account.noWallet": "No wallet on this account yet.",
  "shell.account.network": "Network to sign on",
  "shell.account.walletHint":
    "Select a wallet in your wallet app, then sign the message Templ shows to prove you control it. This does not send a transaction.",
  "shell.account.waitingWallet": "Waiting for your wallet…",
  "shell.account.addWallet": "Add a wallet",
  "shell.account.connected": "Connected: {address}",
  "shell.account.solanaWallets": "Solana wallets",
  "shell.account.solanaHint":
    "Add up to {count} Solana wallets to sign in to this account. Your wallet signs a message; nothing is spent.",
  "shell.account.noSolanaWallet": "No Solana wallet on this account yet.",
  "shell.account.addSolanaWallet": "Add a Solana wallet",
  "shell.account.waitingSolanaWallet": "Waiting for your wallet…",
  "shell.account.solanaWalletMissing":
    "No Solana wallet was found in this browser.",
  "shell.account.solanaAdded": "Solana wallet added.",
  "shell.account.solanaRemoved": "Solana wallet removed.",
  "shell.account.removeSolanaWallet": "Remove Solana wallet",
  "shell.account.bitcoinWallets": "Bitcoin wallets",
  "shell.account.bitcoinHint":
    "Sign in with up to {count} Bitcoin wallets. Adding a wallet is free.",
  "shell.account.noBitcoinWallet": "No Bitcoin wallet on this account yet.",
  "shell.account.addBitcoinWallet": "Add a Bitcoin wallet",
  "shell.account.bitcoinAdded": "Bitcoin wallet added.",
  "shell.account.bitcoinRemoved": "Bitcoin wallet removed.",
  "shell.account.removeBitcoinWallet": "Remove Bitcoin wallet",
  "shell.account.confirm": "Confirm {label}",
  "shell.account.current": "Current",
  "shell.account.removeWallet": "Remove wallet",
  // lib/account-methods.ts
  "shell.account.lastMethodNotice":
    "This is your last wallet. Add another one before removing it.",
  // Account wallet verification
  "shell.account.walletRemoveNotice":
    "Removing this wallet ends its access to this account and signs out any session it opened.",
  // app/[slug]/page.tsx (document title)
  "shell.chat.title": "Support",
  // safety-report-form.tsx (SAFETY_REASONS in packages/chat keeps the English
  // labels; thrown link and validation errors and the worker's answers keep
  // their English)
  "shell.safety.reason.legalRequest": "Request from a legal authority",
  "shell.safety.reason.mandatoryNotice": "Notice required by law",
  "shell.safety.reason.childSafety": "Child sexual exploitation or abuse",
  "shell.safety.reason.imminentHarm":
    "Immediate threat to life or serious injury",
  "shell.safety.reason.appeal": "Appeal a platform decision",
  "shell.safety.received": "Report received",
  "shell.safety.keepId":
    "Keep this ID for any follow-up or appeal. It confirms submission, not a review decision.",
  "shell.safety.authorityPending":
    "Authority verification is pending. This receipt does not confirm authority or approval of the request.",
  "shell.safety.dutyPending":
    "The claimed legal duty is pending review. This receipt does not confirm that it applies to Templ.",
  "shell.safety.copied": "Copied",
  "shell.safety.copyId": "Copy report ID",
  "shell.safety.newReport": "New report",
  "shell.safety.title": "Legal requests and appeals",
  "shell.safety.targetLead":
    "We’ll check your access before including the reported content.",
  "shell.safety.lead":
    "Requests from authorities, notices required by law, urgent safety reports and platform appeals. Protocol teams handle ordinary support disputes.",
  "shell.safety.checkingAvailability": "Checking reporting availability",
  "shell.safety.notAvailable":
    "Reporting is not available yet. Your report has not been sent.",
  "shell.safety.temporarilyUnavailable":
    "Reporting is temporarily unavailable. Your report has not been sent.",
  "shell.safety.checkAgain": "Check again",
  "shell.safety.reason": "Reason",
  "shell.safety.chooseReason": "Choose a reason",
  "shell.safety.message": "Message",
  "shell.safety.chat": "Workspace",
  "shell.safety.openReported": "Open reported content",
  "shell.safety.messageNumber": "Message #{id}",
  "shell.safety.link": "Templ link",
  "shell.safety.reporterName": "Your name or organization",
  "shell.safety.contactEmail": "Contact email",
  "shell.safety.jurisdiction": "Country or jurisdiction",
  "shell.safety.jurisdictionHint": "Where you believe the law applies",
  "shell.safety.legalBasis": "Law or legal basis",
  "shell.safety.legalBasisHint":
    "Name the law or describe the unlawful conduct",
  "shell.safety.evidence": "Content location and evidence",
  "shell.safety.evidenceHint":
    "Identify the message, case, time or file. Add facts or document references operators can check.",
  "shell.safety.noticeObligation": "Law requiring this notice",
  "shell.safety.noticeObligationHint":
    "Cite the law and provision requiring Templ to accept it",
  "shell.safety.noticeCheck":
    "Operators will check whether this legal duty applies. This exception does not cover ordinary support disputes.",
  "shell.safety.authority": "Authority or agency",
  "shell.safety.officialContact": "Official contact reference",
  "shell.safety.officialContactHint": "Official directory page and contact",
  "shell.safety.reference": "Order or request reference",
  "shell.safety.requestedAction": "Requested action",
  "shell.safety.actionRemoval": "Remove content",
  "shell.safety.actionPreservation": "Preserve records",
  "shell.safety.actionDisclosure": "Request information",
  "shell.safety.authorityCheck":
    "Operators independently check the authority, legal instrument and scope. This form grants no access to private information and triggers no disclosure.",
  "shell.safety.goodFaith":
    "I believe this notice is accurate and complete, and submit it in good faith.",
  "shell.safety.urgentHint":
    "Give the exact location and facts below. No name, email or court order is required. For immediate danger, contact local emergency services too.",
  "shell.safety.reportId": "Report ID <optional>(optional)</optional>",
  "shell.safety.reportIdHint": "From your report receipt",
  "shell.safety.reconsider": "What should we reconsider?",
  "shell.safety.whatHappened": "What happened?",
  "shell.safety.reconsiderHint":
    "Explain what was wrong or what context was missed.",
  "shell.safety.whatHappenedHint": "Explain the issue and where to find it.",
  "shell.safety.contentNote":
    "Don’t copy illegal material, invitation secrets or private keys here.",
  "shell.safety.charCountLabel": "{count} of 2000 characters",
  "shell.safety.charCount": "{count} / 2,000",
  "shell.safety.sending": "Sending report",
  "shell.safety.tryAgainIn": "Try again in {seconds}s",
  "shell.safety.submitAppeal": "Submit appeal",
  "shell.safety.submitReport": "Submit report",
  "shell.safety.emergency":
    "For immediate danger, contact local emergency services.",
  "shell.safety.unconfirmed":
    "Could not confirm receipt. Try again to check this report.",
  "shell.safety.signInToReport":
    "Sign in to report this content. Nothing was sent.",
  // ActionToast (action-toast.tsx; the notice text is the caller's)
  "shell.toast.dismiss": "Dismiss notice",
  // NativeSlugPage (native-slug-page.tsx, when a slug resolves to nothing)
  "shell.slug.unavailableTitle": "This workspace link is unavailable.",
  "shell.slug.unavailableBody":
    "It may have been released or typed incorrectly.",
  "shell.slug.inbox": "Open inbox",
} as const;
