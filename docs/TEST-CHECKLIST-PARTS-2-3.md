# Parts 2 and 3 test checklist

Use fake data only. Logins are in `.dev/seed-credentials.md`, and test emails appear at
http://localhost:3000/dev/inbox. To reset, run `pnpm seed`.

- Alpha Motors has approved KYC, so use it for creating cases.
- Beta Loans has no KYC, so use it for the KYC journey.
- Staff sign in at http://localhost:3000/ops/signin

## Partner registration
- [ ] Register a new partner from the sign-in page
- [ ] The inbox shows the Reference ID and a password link
- [ ] The link sets a password, then Admin must set up two-step
- [ ] Registering the same admin email again shows the same success, and sends an "already have an account" email
- [ ] Wrong pincode, no product chosen, and bad phone numbers are refused

## Agreement and KYC
- [ ] As `admin@beta.test`, Submit stays off until the agreement and required documents are done
- [ ] PDF, JPG and PNG upload
- [ ] A `.txt` renamed to `.pdf` is refused
- [ ] A file over 10 MB is refused
- [ ] GST certificate is optional
- [ ] After submitting, uploads are locked
- [ ] `executive@beta.test` has no KYC menu
- [ ] Executive at Beta sees "KYC must be approved" on Create Case

## Staff review
- [ ] Staff must set up two-step on first sign-in
- [ ] Partner logins fail at `/ops/signin`, and staff logins fail at `/signin`
- [ ] A submitted partner appears in the queue, and files open
- [ ] Rejecting without a reason is refused
- [ ] Sending back shows the reason to the partner
- [ ] Only the rejected document can be replaced
- [ ] Approving needs every document approved
- [ ] The partner gets an email, and can then create cases

## Create Case
Try all three products: Used Car, Loan Against Car and Personal.

- [ ] Next is refused until required fields are filled, with clear messages
- [ ] Lenders appear only after choosing a product
- [ ] In-House is greyed out
- [ ] Aadhaar field takes only 4 digits
- [ ] Applicant under 18 is refused
- [ ] Bad PAN, phone, pincode and registration numbers are refused
- [ ] Amount and tenure outside the product's limits are refused
- [ ] LTV shows live, and warns above 85%
- [ ] FOIR shows live
- [ ] Document list changes with loan type and employment
- [ ] Changing the product warns and clears details
- [ ] Leaving and coming back resumes the draft
- [ ] Two Executives can't see each other's drafts

## Customer consent
- [ ] Create case stays off until the customer agrees
- [ ] The link appears in the inbox. Without a customer email it goes to `sms:+91...`
- [ ] The consent page shows no customer details
- [ ] It works on a phone
- [ ] After "I agree", the wizard updates by itself
- [ ] Changing the customer's PAN or phone afterwards needs a new consent
- [ ] Sending the link again cancels the old link

## Submitting
- [ ] Success shows a Case ID like `CASE-261107-ABC234`
- [ ] A second case for the same customer warns first, and "Create anyway" works
- [ ] Double-clicking Create case makes only one case
