# Test checklist: Parts 4, 5 and 6

Start with `pnpm db`, `pnpm seed` and `pnpm dev`. Logins are in `.dev/seed-credentials.md`. Emails appear at
http://localhost:3000/dev/inbox. Use Alpha Motors for partner steps. Staff sign in at `/ops/signin`.

Write down anything that fails, with the steps and a screenshot. Use fake data only.

## Part 4: case tracking
- [ ] Create a case as the Alpha executive. All Cases shows it, with the name and phone masked
- [ ] Search by case ID, last 4 digits of the phone, and vehicle number
- [ ] Try the Needs Action, Active, Disbursed and Rejected filters, plus product and month
- [ ] Copy a filtered page address into a new tab. It shows the same list
- [ ] Sign in as a second executive. The first executive's case is not listed, and its address shows an error
- [ ] Viewer sees all cases but has no note box, no Show link and no Withdraw button
- [ ] Open a case. Click Show on the phone. It asks for a reason, then shows the number
- [ ] Add a note. Add an extra document, then open it
- [ ] Download from All Cases as Admin. Names are masked in the file. Executive has no Download button
- [ ] As `ops.agent`, open the Cases queue and take the case. Customer name and phone are nowhere on the page
- [ ] Move it to In Review, then to Needs Action with a note
- [ ] As the partner, the Notifications count goes up and the inbox has an email. Answer the note and send it back
- [ ] As ops, move to Approved, Customer Approved and Disbursing. Each step asks for its details
- [ ] Record a first tranche, not final. The case stays Disbursing. Record the final one. It becomes Disbursed
- [ ] Try a reused UTR, an amount above the sanctioned amount, and a future date. All are refused
- [ ] Withdraw another case as the partner. It needs a reason and can't move afterwards
- [ ] Dashboard: each number matches the list it opens. Try the Revenue tab and the month arrows
- [ ] Open the same case in two tabs, change it in one, then act in the other. You see a "changed elsewhere" message
- [ ] Open Vittora in a second tab, then save something in the first tab. It works

## Part 5: commissions
- [ ] After a disbursal with Test Bank One, Invoices shows a draft. Check 1% commission, 18% GST, 2% TDS
- [ ] Disburse a case with Test Finance NBFC. The invoice waits for a rate
- [ ] As `finance.one`, create a rate card for that lender. You can't approve your own
- [ ] As `finance.two`, approve it. The waiting invoice becomes a draft with amounts
- [ ] Raise is blocked until bank and GST details are verified
- [ ] In Settings save bank and GST details. Status shows Pending verification and only the last 4 digits
- [ ] As `kyc.reviewer`, open the partner, show the details and verify them. Raise now works
- [ ] Raise two invoices. Numbers run in order, starting at 000001
- [ ] Dispute an invoice. As Finance, reinstate one and void another
- [ ] As `finance.one`, approve and record a payout. Confirm paid is not allowed for the same person
- [ ] As `finance.two`, confirm paid. The partner sees Paid
- [ ] As `ops.agent`, request a reversal on a paid case. As Finance, approve it
- [ ] The clawback appears as pending. Approve it as a different Finance user from the one who approved the reversal
- [ ] Pay the next invoice. The amount is taken off the payout and shows on the invoice
- [ ] Reverse a case whose invoice is unpaid. The invoice becomes Void
- [ ] Only Admin sees Invoices

## Part 6: team and settings
- [ ] As Admin, invite a user. There is no password field. The invite email arrives
- [ ] The new user sets a password from the link and signs in
- [ ] Resend an invite. The old link stops working
- [ ] Change a user's role. They are signed out at once
- [ ] End all sessions for a user. They are signed out
- [ ] Deactivate a user with open cases without choosing a replacement. It is refused
- [ ] Choose a replacement. The cases move, and the user can't sign in
- [ ] Reactivate them
- [ ] You can't deactivate yourself, or remove the last Admin
- [ ] Only Admin sees Users
- [ ] Settings: Admin can edit company details. Manager, Executive and Viewer can only read them
- [ ] Reference ID, channel name and products can't be edited
- [ ] Turn off contact masking. Admin sees the phone with no reason needed. Viewer still sees it masked. Turn it back on
- [ ] Edit verified bank details. Status goes back to Pending verification
- [ ] Turn off an email in notification settings. That email stops, and the in-app item still arrives
- [ ] Help: search for "clawback"

## Phones and browsers
- [ ] Repeat a few steps on a real phone, and in Safari and Firefox
