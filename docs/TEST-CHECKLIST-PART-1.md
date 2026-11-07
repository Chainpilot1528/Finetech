# Part 1 test checklist

Use fake data only. Logins are in `.dev/seed-credentials.md`, and test emails appear at
http://localhost:3000/dev/inbox. To reset everything, run `pnpm seed`.

Log each bug as a GitHub Issue with the steps, what you expected and what happened.

## Sign in
- [ ] Sign in as `viewer@alpha.test` with the right password
- [ ] A wrong password and an unknown email show the same message
- [ ] Email in capitals still works
- [ ] Sign out, then press Back: you must not get in

## Too many wrong passwords
- [ ] 5 quick wrong tries: the app asks you to wait a minute
- [ ] 10 wrong tries in 15 minutes: the account locks for 30 minutes
- [ ] The right password fails while locked
- [ ] The inbox shows a lock email to the user and the admin

## Forgot and reset password
- [ ] Unknown email: the same "on its way" message, and no email is sent
- [ ] The link works and the new password signs in
- [ ] Using the same link again fails
- [ ] Requesting a second link makes the first one fail
- [ ] A password under 10 characters is refused, and the link still works after
- [ ] `invited@alpha.test` can set a first password through Forgot password

## Two-step sign-in
- [ ] `admin@alpha.test` and `manager@alpha.test` are forced to set it up
- [ ] Executive and Viewer are not forced, but can turn it on in Settings
- [ ] A wrong code is refused
- [ ] 5 wrong codes send you back to sign in
- [ ] The same code can't be used twice
- [ ] "Email me a code" works once

## Roles
- [ ] Viewer has no Create Case, Invoices or Users
- [ ] Executive has no Invoices or Users
- [ ] Manager has no Invoices or Users
- [ ] Admin sees everything
- [ ] As Executive, type `/app/users` in the address bar: no user data appears

## Partner separation
- [ ] `admin@alpha.test` sees only `@alpha.test` users
- [ ] `admin@beta.test` sees only `@beta.test` users

## Settings
- [ ] Change password: other browsers get signed out
- [ ] Wrong current password is refused
- [ ] "Sign out of all devices" signs out every browser

## Phone and browsers
- [ ] Every screen works at phone width with no sideways scrolling
- [ ] Try Chrome, Safari and a real phone if you can
