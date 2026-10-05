# Meteora permission inquiry: sent 2026-10-05

- Authority: Jeremy chose "Send now" on the card "Send the Meteora permission email from your Gmail?" at 2026-10-05T20:42:30Z.
- Sent: 2026-10-05 20:43Z from armygep5@gmail.com (Gmail message id 1a10dce5cd7e20c5) to meteora_support@meteora.ag (the Notices address in Meteora's Terms of Service).
- Attachments: none. No code, ZIP, keys or project data.
- Change from the approved draft (spec/reviews/2026-09-27-repair-decision/METEORA-INQUIRY.md, left unchanged so its SHA256SUMS still hold): the status sentence now says devnet testing is live with valueless test tokens, nothing on mainnet, no real funds, and that we do not fork, copy or modify their program code. "Before proceeding" became "Before any mainnet use". Signed with the full name.
- An unanswered email is not consent. Mainnet stays blocked on a written answer (DEPLOYMENT.md §2 item 1, ADR-002).

## Text as sent

Subject: U.S.-based developer: DBC/DAMM integration and test permissions

Hello Meteora team,

I'm a U.S.-based developer building a closed-source token launch application that integrates your deployed DBC and DAMM v2 programs through the published TypeScript SDKs. We do not fork, copy or modify your program code. Testing is currently on Solana devnet only, with valueless test tokens. Nothing runs on mainnet and no real funds are involved.

Before any mainnet use, please route this to the appropriate developer-partnership or legal contact and clarify:

1. Whether U.S.-based developers may perform SDK-only development, read-only program/config inspection and public-devnet integration, and which agreement governs each activity. If the published territorial restriction applies, is a separate written developer agreement available?

2. Whether commercial integration with the existing deployed programs requires additional permission or partner terms, including for a third-party launch interface. We do not intend to relicense your programs.

3. Whether private development may copy deployed program binaries into a local validator, build source for testing, or cache test artifacts in private CI. Please distinguish internal use from any distribution and identify the applicable written permission or licence.

4. Which documented devnet DBC/DAMM versions and config addresses you recommend. For the pinned Customizable migration path, please confirm the required dynamic config and creator authority and point us to current deployment/build-verification records.

Separately, the published cp-amm-sdk 1.4.10 manifest includes a runtime dependency named chain. Is that intentional, and is an upstream removal planned?

Please identify the agreement/version and scope of any permission rather than a general indication that integration is supported.

Regards,
Jeremy Gephart
