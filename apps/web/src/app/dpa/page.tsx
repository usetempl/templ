import Link from "next/link";
import { CORPUS_LIMITS, PRODUCT_LIMITS } from "@templ/chat/plans";
import { EVAL_LIMITS } from "@templ/chat/support-eval";
import { PolicyPage, PolicySection } from "@/components/policy-page";
import { TalkToTempl } from "@/components/talk-to-templ";
import { getRelease } from "@/lib/config";

export const metadata = {
  title: "Data Processing Addendum",
  description:
    "The data duties of Templ and the team that runs your support workspace.",
};

export default async function DpaPage() {
  const RELEASE = await getRelease();
  return (
    <PolicyPage
      title="Data Processing Addendum"
      description="The data duties of Templ and your support team."
      active="dpa"
    >
      <p>
        {
          "Your organization controls its users' support data. Templ processes that data to run support for you. This includes enabled AI and agreed work by Templ staff. Your manager chooses who enters the inbox. This addendum sets our processing, security, provider and deletion duties."
        }
      </p>
      <PolicySection title="1. The parties and agreement" id="d-1">
        <p>{"This addendum is part of your agreement with templ.fun Ltd."}</p>
        <p>
          {
            "“Templ” means templ.fun Ltd, a BVI Limited Company. Its company number is 2191511. It registered on 28 October 2025. Its registered and mailing address is Quijano Chambers, P.O. Box 3159, Road Town, British Virgin Islands."
          }
        </p>
        <p>
          {
            "“Customer” means the organization that runs the workspace. Its details appear in its account agreement or signed order form. An authorized person accepts this Data Processing Addendum (“DPA”) for Customer."
          }
        </p>
        <p>
          {"The DPA forms part of the "}
          <Link href="/terms">{"Terms"}</Link>
          {
            " or signed service agreement. It applies while Templ processes Customer Personal Data. It continues until that processing ends."
          }
        </p>
        <p>
          {
            "The DPA prevails over conflicting commercial terms about data processing. Mandatory transfer clauses prevail over both. A signed order form may add protections. It cannot remove mandatory protections."
          }
        </p>
        <p>
          {
            "The agreed scope and enabled workspace features set the service. Describing a feature here does not activate it. A workspace flag grants no access or exemption from security rules."
          }
        </p>
      </PolicySection>
      <PolicySection title="2. Data terms and roles" id="roles">
        <p>
          {"Customer controls support data. Templ processes it for Customer."}
        </p>
        <p>
          {
            "“Personal Data” means information about an identified or identifiable person. It includes personal information under applicable US privacy law. “Customer Personal Data” means Personal Data Templ processes for Customer through the Service."
          }
        </p>
        <p>
          {
            "“Service” means Templ's support widget, inbox, API and agreed related services. “User” means a person who asks Customer for support. “Subprocessor” means another processor Templ appoints to handle Customer Personal Data."
          }
        </p>
        <p>
          {
            "“Data Protection Law” means privacy law that applies to the processing. This includes the BVI Data Protection Act, 2021. It also includes applicable EU GDPR, UK GDPR and California privacy law. These legal terms retain their statutory meanings."
          }
        </p>
        <p>
          {
            "Customer is the controller. Templ is its processor. Where Customer acts for another controller, Templ acts as a subprocessor. Customer must have authority to give the controller's instructions. It must pass on relevant duties."
          }
        </p>
        <p>
          {
            "Templ separately controls necessary account, billing, business measurement, direct support, platform security and legal-duty records. That role does not permit repurposing Customer cases. The "
          }
          <Link href="/privacy">{"Privacy policy"}</Link>
          {
            " explains those uses. Section 12 separately limits improvement use."
          }
        </p>
      </PolicySection>
      <PolicySection title="3. Customer's instructions" id="d-2">
        <p>
          {
            "Customer chooses lawful support purposes and tells Templ what to process."
          }
        </p>
        <p>
          {
            "Customer must follow Data Protection Law. It must give clear notices and establish lawful grounds. It must obtain consent where required. It must assess sensitive data, AI and international transfers it instructs."
          }
        </p>
        <p>
          {
            "Customer controls staff grants, agents, integrations, support instructions and case decisions. It must keep permissions current and collect only needed data. It must never ask users for private keys or recovery phrases."
          }
        </p>
        <p>
          {
            "Documented instructions include the agreement, DPA, signed order form and saved workspace settings. They also include lawful written instructions through the agreed contact channel. Annex A describes the permitted processing. These rules also cover transfers."
          }
        </p>
        <p>
          {
            "An unavailable feature cannot carry out an instruction. Templ will explain the limit and seek a lawful alternative. Templ must not continue unlawful processing because a feature is unavailable."
          }
        </p>
      </PolicySection>
      <PolicySection
        title="4. Templ's processing duties"
        id="processing-duties"
      >
        <p>
          {
            "Templ uses Customer data for the agreed purposes and lawful instructions."
          }
        </p>
        <p>
          {
            "Templ will process Customer Personal Data only on Customer's documented instructions. Annex A lists the limited purposes. Templ will not sell that data or use it for advertising. Templ will not train or fine-tune models on it."
          }
        </p>
        <p>
          {
            "Legally required departures from instructions remain subject to applicable processor and transfer law. Under EU GDPR, this exception requires Union or Member State law. Under UK GDPR, it requires applicable UK law. Templ will tell Customer beforehand unless that qualifying law prohibits notice. Foreign demands must also meet applicable GDPR Article 48 and transfer-clause duties. A demand alone cannot override Customer's instructions."
          }
        </p>
        <p>
          {
            "Templ will immediately tell Customer if an instruction appears to breach Data Protection Law. Templ may pause the affected processing while the parties resolve it. Templ will also report an inability to meet its applicable DPA duties."
          }
        </p>
        <p>
          {
            "Templ will keep information needed to show compliance. It will cooperate with competent authorities as law requires. Each party retains its own legal duties and liability."
          }
        </p>
      </PolicySection>
      <PolicySection
        title="5. Staff access and confidentiality"
        id="staff-access"
      >
        <p>
          {
            "Staff need current permission. Templ staff need Customer's explicit grant to enter its inbox."
          }
        </p>
        <p>
          {
            "Templ will limit personnel access to authorized people who need the data for assigned work. Those people must have binding confidentiality duties. This includes employees and contractors. Templ will give them relevant privacy and security instructions."
          }
        </p>
        <p>
          {
            "A signed order form may include managed AI or done-for-you support. Done-for-you support means Templ people answer Customer's users under Customer's instructions. The order must state its scope, permitted tasks, coverage and escalation rules."
          }
        </p>
        <p>
          {
            "Customer's manager must explicitly grant each Templ staff member the relevant workspace role. Payment, operator status, a flag, order form or ordinary assignment grants no inbox access. Templ staff must follow Customer's support instructions. They cannot use cases for their own purposes."
          }
        </p>
        <p>
          {
            "Customer may revoke a grant. Current-access checks apply to every later private read, write, search result, export, attachment and event. Removing the grant ends inbox access. The order form and applicable service access rules also limit that access."
          }
        </p>
        <p>
          {
            "Narrow infrastructure processing follows this DPA. It creates no standing support role in Customer's inbox."
          }
        </p>
      </PolicySection>
      <PolicySection title="6. AI and integrations" id="ai">
        <p>
          {
            "Customer chooses its agents. AI follows the same instructions and access limits."
          }
        </p>
        <p>
          {
            "Registered agents may read only cases their current permissions and AI mode allow. In AI answers mode, they may reply. In AI drafts only mode, they may draft for staff. In AI off mode, they cannot read or work on the case."
          }
        </p>
        <p>
          {
            "An agent cannot change its mode or send a staff draft as a person. A person's reply from a draft counts as that person's reply."
          }
        </p>
        <p>
          {
            "An enabled Templ-managed agent uses a model provider listed in Annex C. That provider is a Subprocessor for this work. Templ will limit inputs to the authorized service purpose. Model calls grant no permission for model training."
          }
        </p>
        <p>
          {
            "AI may make mistakes. Customer must set suitable review and handoff rules. Customer must assess decisions that could have legal or similarly significant effects. The DPA authorizes no unlawful automated decision."
          }
        </p>
        <p>
          {
            "A provider Customer appoints directly is Customer's provider. Customer is responsible for that appointment, notice and instructions. Templ's disclosures and its own processing still follow this DPA."
          }
        </p>
        <p>
          {
            "Chat is untrusted input. Chat and AI cannot sign or send transactions. They must never request private keys or recovery phrases. Wallet sign-in happens in a separate authentication flow."
          }
        </p>
      </PolicySection>
      <PolicySection title="7. Security duties" id="d-4">
        <p>
          {
            "Templ must maintain security measures suited to the data and risks."
          }
        </p>
        <p>
          {
            "Templ will maintain appropriate technical and organizational measures. These must meet applicable duties, including GDPR Article 32. Annex B states the service controls and operational duties."
          }
        </p>
        <p>
          {
            "Templ will consider risks, data, available technology and implementation costs. It must protect confidentiality, integrity, availability and resilience. It must maintain suitable recovery procedures and test relevant controls. It must use encryption and pseudonymisation where appropriate."
          }
        </p>
        <p>
          {
            "Private cases are not end-to-end encrypted. Authorized service processing can handle content. No measure removes every risk. Templ claims no security certification or independent audit here."
          }
        </p>
        <p>
          {
            "Templ may improve or replace measures. It must not materially reduce overall protection. It will give Customer information needed to assess a material change."
          }
        </p>
      </PolicySection>
      <PolicySection title="8. Personal Data Breaches" id="breaches">
        <p>
          {
            "Templ will tell Customer without undue delay about a breach affecting its data."
          }
        </p>
        <p>
          {
            "A “Personal Data Breach” is a security breach affecting Customer Personal Data. It includes accidental or unlawful loss, destruction, alteration, unauthorized disclosure or unauthorized access."
          }
        </p>
        <p>
          {
            "Templ will notify Customer without undue delay after becoming aware of a Personal Data Breach. Notice goes to Customer's designated privacy or security contact. Otherwise, it goes to the manager through the agreed channel. Customer must keep that contact current."
          }
        </p>
        <p>
          {
            "The notice will give known facts about affected data, people, likely effects and response steps. It will include available counts and a follow-up contact. Templ may provide details in stages. It must not wait for every fact before notifying Customer."
          }
        </p>
        <p>
          {
            "Templ will contain and investigate the breach. It will help Customer meet regulator and user notice duties. Customer decides its notices unless law imposes a separate duty on Templ. Notice alone does not admit liability."
          }
        </p>
      </PolicySection>
      <PolicySection title="9. Privacy and compliance help" id="d-9">
        <p>
          {
            "Templ helps Customer answer privacy requests and meet its legal duties."
          }
        </p>
        <p>
          {
            "Templ will use appropriate measures to help Customer answer requests. These include access, correction, deletion, portability, restriction and objections where applicable. Assistance considers the nature of processing and available information."
          }
        </p>
        <p>
          {
            "Templ will promptly pass requests about Customer Personal Data to Customer. It may confirm receipt and explain Customer's role. It will not decide for Customer unless instructed or legally required. It handles any part concerning its own controller data."
          }
        </p>
        <p>
          {
            "Verification must protect other people's data and remain proportionate. Neither party may request private keys or recovery phrases as proof. A privacy request must not require payment or a transaction signature."
          }
        </p>
        <p>
          {
            "Templ will help with security duties, breach notices, data protection impact assessments and prior consultations. It will provide relevant information it holds. Section 13 adds California duties."
          }
        </p>
        <p>
          {
            "Any agreed fee for additional assistance must not obstruct mandatory rights or legal deadlines. Templ will not charge Customer to fix Templ's own DPA breach."
          }
        </p>
      </PolicySection>
      <PolicySection title="10. Subprocessor changes" id="d-3">
        <p>
          {
            "Customer can check providers and object to a data protection risk before a change."
          }
        </p>
        <p>
          {
            "Customer gives general written authorization for Annex C's Subprocessors and purposes. Templ must verify identity, contracts and safeguards before their affected processing. Optional providers receive data only when their feature is enabled and authorized."
          }
        </p>
        <p>
          {
            "Templ will keep the register accurate. It must identify providers, purposes, data categories and processing countries. It must distinguish optional processing from enabled processing."
          }
        </p>
        <p>
          {
            "Templ will give prior written notice before adding or replacing a Subprocessor. It will use Customer's designated contact or agreed notice channel. Customer must have a reasonable opportunity to object before the new provider receives its data. A webpage update alone does not replace this notice."
          }
        </p>
        <p>
          {
            "Customer may object on reasonable data protection grounds. The parties will seek a lawful solution before the provider receives affected data. If none exists, either party may end the affected processing. Refunds follow the Terms, signed order form and mandatory law. This clause creates no additional refund right."
          }
        </p>
        <p>
          {
            "Templ must bind Subprocessors to written duties providing at least equivalent data protection. These cover confidentiality, security, assistance, deletion and transfers. Templ remains responsible to Customer for their compliance."
          }
        </p>
      </PolicySection>
      <PolicySection title="11. International transfers" id="d-10">
        <p>
          {
            "A lawful transfer arrangement must cover restricted processing before it starts."
          }
        </p>
        <p>
          {
            "Templ will transfer data only on documented instructions and in compliance with Data Protection Law. It must record relevant provider locations and safeguards. Annex D lists the required transfer details."
          }
        </p>
        <p>
          {
            "Where needed, parties must enter the applicable EU Standard Contractual Clauses (“SCCs”) under Decision (EU) 2021/914. Module 2 covers controller-to-processor transfers. Module 3 covers processor-to-processor transfers. Separate controller transfers need their applicable arrangement; these processor modules do not authorize improvement use."
          }
        </p>
        <p>
          {
            "The parties must select the correct module and complete required annexes and choices. They must assess transfer risks and required extra safeguards. Templ must also cover onward transfers. It will provide relevant information it holds."
          }
        </p>
        <p>
          {
            "Restricted UK transfers need an appropriate UK instrument. This may be the International Data Transfer Agreement or approved UK Addendum. Required tables and attachments must be completed. Applicable BVI transfer rules apply separately."
          }
        </p>
        <p>
          {
            "This DPA does not state that transfer instruments are already signed. A public link or provider policy alone does not create a lawful transfer arrangement. Affected transfers must not start without one. If safeguards fail, affected transfers must stop or use a lawful replacement."
          }
        </p>
        <p>
          {
            "Transfer clauses control their own governing law, courts, regulator and user rights. BVI governing law in the Terms cannot override them."
          }
        </p>
      </PolicySection>
      <PolicySection title="12. Evaluation and improvement copies" id="d-5">
        <p>
          {
            "De-identified copies can still identify people. Separate uses need separate lawful grounds."
          }
        </p>
        <p>
          {RELEASE.supportCorpusVerified
            ? "Improvement copying is enabled under these rules."
            : "Templ does not make improvement copies yet."}{" "}
          <Link href="/availability">Feature availability</Link>
          {" shows public features."}
        </p>
        <p>
          {
            "Customer controls evaluation copies saved inside its workspace. They remain Customer Personal Data under this DPA. A person must check each copy before saving. Authorized export and agent access follow Customer's settings. Templ does not read those copies for its own improvement purpose."
          }
        </p>
        <p>
          {"Templ's separate improvement use follows "}
          <Link href="/privacy#improvement">{"Privacy section 7"}</Link>
          {
            " and its release gate. Copies help improve AI answers, rules and setup. They also help check resolution rules and review disputed charges. Copies never create or change a charge."
          }
        </p>
        <p>
          {
            "Where lawfully enabled, Templ is an independent controller from the separate de-identification step onward. That step occurs inside the workspace. Accepting this DPA or giving a Customer notice does not itself supply lawful grounds. Templ must establish its own grounds, required notices, user choices and transfers."
          }
        </p>
        <p>
          {
            "De-identified copies can still identify people. The rules cannot find every name. Public chain facts can identify someone. Templ treats these copies as Personal Data."
          }
        </p>
        <p>
          {
            "Only cases whose opening message showed the improvement notice are eligible. The notice version stays with the case. Copies exclude internal notes, screenshots, other files, account identifiers, wallets, website data and IP data. They keep cleaned messages, workspace-specific writer pseudonyms and limited case facts. Detected secrets or leftover identifiers cause text to be dropped."
          }
        </p>
        <p>
          {
            "Templ must not identify people from copies, profile them, contact them through copies or sell copies. Copies go to no model provider. Templ trains and fine-tunes no model on them."
          }
        </p>
        <p>
          {"At most "}
          {CORPUS_LIMITS.readers}
          {
            " named readers may read copies. Each needs a valid wallet sign-in and a stated purpose. Templ logs every read. Customer sees a monthly count. Reader access never opens raw private cases."
          }
        </p>
        <p>
          {"Copies last at most "}
          {CORPUS_LIMITS.retentionDays}
          {
            " days after creation. Ordinary case deletion may leave a lawful copy within that limit. A recorded user privacy request or objection removes their copies sooner. It also stops new copies of that user's cases in that workspace. Workspace deletion removes its copies. A legal hold never keeps a copy."
          }
        </p>
        <p>
          {
            "No product setting excludes a workspace. Only a signed custom contract does. "
          }
          <TalkToTempl topic="privacy" label="Talk to us">
            {"Talk to us"}
          </TalkToTempl>
          {
            " to discuss one. Users can still object for free. Customer notices must explain applicable copying before it starts and link to Privacy section 7."
          }
        </p>
        <p>
          {
            "Section 13 prevails for California service-provider data. Templ must keep copying off where it would breach those restrictions. Calling Templ a controller cannot bypass them. A lawful separate arrangement must be assessed and documented before its processing."
          }
        </p>
      </PolicySection>
      <PolicySection
        title="13. California service-provider terms"
        id="california"
      >
        <p>
          {
            "Templ uses covered California data within specific, lawful service-provider limits."
          }
        </p>
        <p>
          {
            "This section applies where Customer is a business under the CCPA, as amended by the CPRA. Templ acts as its service provider or contractor for Customer Personal Data. Statutory definitions apply."
          }
        </p>
        <p>
          {
            "Customer discloses data only for the limited, specific business purposes in Annex A. Templ must not sell or share it. Templ must not retain, use or disclose it for other purposes or commercial purposes. Exceptions apply only where expressly permitted by the CCPA and its regulations."
          }
        </p>
        <p>
          {
            "Templ must not retain, use or disclose this data outside the direct Customer relationship. It must not combine it with other customers' data or its own consumer interactions. Only express statutory or regulatory exceptions may permit those acts. Cross-context behavioral advertising is prohibited. Section 12 creates no exception."
          }
        </p>
        <p>
          {
            "Templ must comply with applicable CCPA provisions and regulations. It must provide the same required level of privacy protection. It certifies that it understands and will follow these restrictions. It must notify Customer after determining it can no longer comply."
          }
        </p>
        <p>
          {
            "Customer may take reasonable steps to check compliance. These include manual reviews, scans, assessments, audits or testing under section 15. On notice, Customer may take reasonable steps to stop and remedy unauthorized use. Templ must cooperate and provide relevant evidence."
          }
        </p>
        <p>
          {
            "Customer must pass relevant verified requests and instructions to Templ. Templ will assist with access, correction, deletion, opt-out and sensitive-use limits where applicable. It must bind its providers to the applicable terms and pass on required deletion instructions."
          }
        </p>
        <p>
          {
            "Templ will provide necessary facts it holds for applicable Customer cybersecurity audits, risk assessments and automated decisionmaking duties. It must not misrepresent those facts. These duties apply where the relevant California requirements cover the processing."
          }
        </p>
      </PolicySection>
      <PolicySection title="14. Retention, return and deletion" id="d-7">
        <p>
          {
            "Customer chooses return or deletion when processor work ends. Legal retention exceptions remain narrow."
          }
        </p>
        <p>
          {
            "During service, resolved, abandoned and spam cases enter scheduled deletion "
          }
          {PRODUCT_LIMITS.supportHistoryDays}
          {
            " days after their last message. This includes related notes, activity and screenshots. Cleanup may run on later activity or in batches. Open cases stay while open. A valid legal hold can pause deletion of covered service records. Valid privacy requests may require earlier deletion."
          }
        </p>
        <p>
          {"Evaluation copies last up to "}
          {EVAL_LIMITS.retentionDays}
          {
            " days after saving and may outlive ordinary cases. Relevant privacy requests remove linked copies before the case. Workspace deletion removes them. Legal holds never extend copy retention. Section 12 governs improvement copies separately."
          }
        </p>
        <p>
          {"Other records follow "}
          <Link href="/privacy#retention">{"Privacy retention rules"}</Link>
          {
            ". Some roles, settings and account records have no automatic expiry. This does not permit unlimited retention after processing ends."
          }
        </p>
        <p>
          {
            "At processing's end, Templ will return or delete Customer Personal Data, at Customer's choice. Return includes an available authorized export. After return, Templ will delete existing copies unless qualifying law requires retention. For EU GDPR data, that means Union or Member State law. For UK GDPR data, that means applicable UK law. Deletion must occur without undue delay and within applicable legal deadlines. Customer may ask for written confirmation."
          }
        </p>
        <p>
          {
            "If Customer gives no choice, Templ will ask for instructions. It must limit retained data to necessary return or deletion work. Ending service does not promise an immediate automatic purge."
          }
        </p>
        <p>
          {
            "Enabled workspace deletion closes access and allows the manager 7 days to cancel. Batched deletion then starts, subject to valid holds. Where that feature is unavailable, Customer can "
          }
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {" for verified return or deletion."}
        </p>
        <p>
          {
            "Provider backups and logs may follow separate technical cycles. Templ must restrict retained copies from ordinary use and protect them under this DPA. Restored data must retain access controls and valid deletion instructions. Templ must arrange lawful expiry or deletion with its providers."
          }
        </p>
        <p>
          {
            "Required legal retention must be limited to affected data and purpose. Templ will explain the legal reason and duration where allowed. A general wish to keep records is insufficient. A hold never extends evaluation or improvement copy retention."
          }
        </p>
        <p>
          {
            "Templ may retain necessary controller billing and legal records where lawful. This does not permit keeping whole cases for account administration. Public blockchain records and copies others independently hold cannot be erased by Templ."
          }
        </p>
      </PolicySection>
      <PolicySection title="15. Audits and evidence" id="d-11">
        <p>
          {
            "Customer can check compliance and require an appropriate audit or inspection."
          }
        </p>
        <p>
          {
            "Templ will provide information needed to show compliance with this DPA and applicable processor duties. It will allow and contribute to audits and inspections by Customer or its appointed auditor. This includes relevant Subprocessor and transfer duties."
          }
        </p>
        <p>
          {
            "The parties may start with documents where these satisfy the request. Evidence may include access controls, retention procedures, incident records and provider terms. Templ must not claim reports or certifications that do not exist."
          }
        </p>
        <p>
          {
            "Customer should give reasonable notice and protect security and confidentiality. Audits must protect other customers' data and avoid unnecessary disruption. These arrangements cannot block legally required audits or material breach investigations. Signed transfer clauses prevail over contrary limits."
          }
        </p>
        <p>
          {
            "Where copying applies, Templ will provide available read summaries, rules and identifier-check results. These give no access to other customers' data or raw private cases."
          }
        </p>
        <p>
          {
            "Each party normally pays its own costs. Templ bears reasonable costs needed to investigate and fix its material noncompliance. Extra fees need prior agreement and cannot obstruct mandatory rights."
          }
        </p>
      </PolicySection>
      <PolicySection title="16. Liability, changes and contact" id="contact">
        <p>
          {
            "Commercial liability terms cannot remove mandatory privacy or transfer rights."
          }
        </p>
        <p>
          {
            "The service agreement's liability terms apply where lawful. They do not limit rights or liability that law or mandatory transfer clauses protect. Each party remains responsible for its own legal duties."
          }
        </p>
        <p>
          {
            "The Terms govern ordinary contract law and venue, subject to section 11. A public page update cannot remove agreed safeguards without required agreement and notice. Transfer clauses change only under their own rules."
          }
        </p>
        <p>
          {"Customer must give Templ a current privacy or security contact. "}
          <TalkToTempl topic="privacy" label="Ask about data">
            {"Ask about data"}
          </TalkToTempl>
          {
            " to send processing instructions or privacy requests. The privacy request address is privacy@usetempl.com. "
          }
          <TalkToTempl topic="legal" label="Send legal notice">
            {"Send legal notice"}
          </TalkToTempl>
          {
            " for a legal notice. The legal notice address is legal@usetempl.com. The registered address in section 1 also accepts written notices."
          }
        </p>
      </PolicySection>
      <PolicySection
        title="Annex A. Processing details"
        id="processing-details"
      >
        <p>
          {
            "This annex states the people, data and specific work covered by this DPA."
          }
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Item"}</th>
              <th scope="col">{"Agreed scope"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Subject matter"}</td>
              <td>
                {
                  "Private support for Customer's protocol or app through its workspace."
                }
              </td>
            </tr>
            <tr>
              <td>{"Duration"}</td>
              <td>
                {
                  "The service term and necessary return, deletion or legally required retention period."
                }
              </td>
            </tr>
            <tr>
              <td>{"People"}</td>
              <td>
                {
                  "Users, managers, authorized staff and people named in support material."
                }
              </td>
            </tr>
            <tr>
              <td>{"Data"}</td>
              <td>
                {
                  "Wallets and sign-in proofs, guest credentials, chosen names, messages, notes, shared transactions, screenshots and approved app context. Also optional notice emails, case activity, permissions, support knowledge and necessary security metadata."
                }
              </td>
            </tr>
            <tr>
              <td>{"Operations"}</td>
              <td>
                {
                  "Receive, organize, store, retrieve, display, transmit, check public chain data, draft, reply, redact, export, restrict, return and delete."
                }
              </td>
            </tr>
            <tr>
              <td>{"Specific business purposes"}</td>
              <td>
                {
                  "Deliver user messages to authorized staff. Keep private case history and check shared transactions. Provide approved AI answers and drafts. Send requested notices. Manage permissions and follow-ups. Carry out authorized exports and privacy requests. Secure, troubleshoot and maintain that workspace's service."
                }
              </td>
            </tr>
            <tr>
              <td>{"Done-for-you work"}</td>
              <td>
                {
                  "Only where ordered and granted: Templ staff review and answer cases under Customer's documented instructions."
                }
              </td>
            </tr>
            <tr>
              <td>{"Sensitive data"}</td>
              <td>
                {
                  "Ordinary support does not request special-category or criminal-offence data. Free text may contain it. Customer must assess lawful grounds and safeguards before instructing that processing. Private keys and recovery phrases are prohibited."
                }
              </td>
            </tr>
            <tr>
              <td>{"Frequency"}</td>
              <td>
                {
                  "Ongoing during service use. Optional functions run only when enabled."
                }
              </td>
            </tr>
            <tr>
              <td>{"Instructions"}</td>
              <td>
                {
                  "The agreement, DPA, signed order form, saved settings, granted permissions and lawful written instructions."
                }
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          {
            "Customer must document material additions to this scope. Templ must assess them before acceptance."
          }
        </p>
      </PolicySection>
      <PolicySection title="Annex B. Security measures" id="security-measures">
        <p>
          {
            "These controls keep cases private and limit misuse. Templ must maintain appropriate operational measures too."
          }
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Area"}</th>
              <th scope="col">{"Measures and limits"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Authentication"}</td>
              <td>
                {
                  "Wallet challenges bind domain, URI, chain, nonce and expiry. Widget challenges also bind the workspace. Replay and revocation checks apply. A connected address alone proves no authority."
                }
              </td>
            </tr>
            <tr>
              <td>{"User isolation"}</td>
              <td>
                {
                  "Guest and wallet widget sessions are origin and workspace scoped. They open only that user's cases. They grant no staff or app authority."
                }
              </td>
            </tr>
            <tr>
              <td>{"Staff access"}</td>
              <td>
                {
                  "Managers grant roles explicitly. Every private operation checks current access. Billing, names and ordinary assignments grant no case permission. Specialists have separate case-scoped rules."
                }
              </td>
            </tr>
            <tr>
              <td>{"Files and exports"}</td>
              <td>
                {
                  "Private files inherit case permissions. Member exports exclude internal notes and team-only records. Each export page checks access. Private cases never become public through a support link."
                }
              </td>
            </tr>
            <tr>
              <td>{"Secret checks"}</td>
              <td>
                {
                  "Recognized private keys and recovery phrases are refused before storage. Filters may miss unusual input. Staff and agent replies are screened for signing, approval and transaction requests."
                }
              </td>
            </tr>
            <tr>
              <td>{"Limited disclosures"}</td>
              <td>
                {
                  "Alerts use fixed events and authenticated links. Reply emails omit case text. Ambiguous key-like values are withheld from models and ordinary exports unless shared as typed transactions."
                }
              </td>
            </tr>
            <tr>
              <td>{"Infrastructure"}</td>
              <td>
                {
                  "Cloudflare provides infrastructure and storage. Cases are not end-to-end encrypted. Templ must maintain appropriate transmission, storage and provider-access protections. No storage country is promised here."
                }
              </td>
            </tr>
            <tr>
              <td>{"Personnel and operations"}</td>
              <td>
                {
                  "Templ must limit personnel access and require confidentiality. It must maintain incident, access-review and retention procedures. It must test relevant controls and assess risks at suitable intervals."
                }
              </td>
            </tr>
            <tr>
              <td>{"Recovery"}</td>
              <td>
                {
                  "Templ must maintain suitable incident recovery measures. Restored data keeps access limits and deletion instructions. Section 14 governs return, deletion and retention."
                }
              </td>
            </tr>
          </tbody>
        </table>
      </PolicySection>
      <PolicySection title="Annex C. Subprocessor register" id="subprocessors">
        <p>
          {
            "These providers may process data for the listed purposes. Optional features require separate activation."
          }
        </p>
        <p>
          {
            "This register does not claim every provider receives Customer data now. It authorizes only the stated purposes under sections 10 and 11. The applicable provider record must state legal entity, processing countries, contract, retention and transfer safeguards. Templ must give Customer those details before affected processing starts."
          }
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">{"Provider"}</th>
              <th scope="col">{"Purpose, data and applicability"}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{"Cloudflare"}</td>
              <td>
                {
                  "Hosts sites, API compute, databases, private files and logs. It receives stored Customer data and request metadata, including IP information. Turnstile visitor checks apply only where enabled."
                }
              </td>
            </tr>
            <tr>
              <td>{"Alchemy"}</td>
              <td>
                {
                  "Reads public EVM wallets, transactions and chain details from Templ's servers. Used for enabled chain checks and verification."
                }
              </td>
            </tr>
            <tr>
              <td>{"dRPC"}</td>
              <td>
                {
                  "Reads public wallets, transactions and chain details as a verification source. Used for enabled checks and verification."
                }
              </td>
            </tr>
            <tr>
              <td>{"Helius"}</td>
              <td>
                {
                  "Reads public Solana accounts, signatures and transactions from Templ's servers. Used where configured for enabled Solana checks or payments."
                }
              </td>
            </tr>
            <tr>
              <td>{"Other configured RPC providers"}</td>
              <td>
                {
                  "An additional provider requires identification and authorization before receiving Customer data. This includes a separately selected Solana verification provider."
                }
              </td>
            </tr>
            <tr>
              <td>{"Anthropic"}</td>
              <td>
                {
                  "Generates answers and drafts from permitted case input and knowledge. Applies only to an ordered, enabled Templ-managed service. Templ's own support is separate controller processing."
                }
              </td>
            </tr>
            <tr>
              <td>{"Resend"}</td>
              <td>
                {
                  "Sends enabled notices and verification emails. Receives addresses, codes and confirmation, resume or stop links. It receives no private message text."
                }
              </td>
            </tr>
            <tr>
              <td>{"Sourcify, Blockscout and Etherscan"}</td>
              <td>
                {
                  "Enabled contract-source lookups send public contract addresses and chain identifiers. No private case text is required."
                }
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          {
            "Public blockchain facts can still be Personal Data. Payment RPC reads verify direct stablecoin transfers on enabled networks. Templ never gives an RPC provider custody of user wallets."
          }
        </p>
        <p>
          {
            "Customer-appointed agents and integrations follow section 6. Google Analytics is optional controller-side measurement. It is not authorized to receive Customer support content."
          }
        </p>
      </PolicySection>
      <PolicySection title="Annex D. Transfer details" id="transfer-record">
        <p>
          {
            "Complete the applicable transfer record before restricted processing starts."
          }
        </p>
        <p>
          {"The signed transfer instrument or attached record must identify:"}
        </p>
        <ol>
          <li>
            {
              "Customer and Templ's legal identities, addresses, contacts and roles."
            }
          </li>
          <li>
            {
              "The exporter, importer, processing countries and onward recipients."
            }
          </li>
          <li>
            {
              "People, data, purposes, frequency, duration and safeguards in Annexes A to C."
            }
          </li>
          <li>
            {"The transfer mechanism and evidence that it binds the parties."}
          </li>
          <li>
            {
              "For EU SCCs, the module, choices, governing law, courts and supervisory authority."
            }
          </li>
          <li>
            {
              "For UK instruments, the required tables, linked clauses and attachments."
            }
          </li>
          <li>
            {
              "The transfer assessment, additional safeguards and responsible reviewer."
            }
          </li>
          <li>{"Any separate BVI transfer condition that applies."}</li>
        </ol>
        <p>
          {
            "Templ must not begin affected restricted processing until a lawful arrangement is in place."
          }
        </p>
      </PolicySection>
    </PolicyPage>
  );
}
