## Summary

<!-- What does this change and why? -->

## Testing

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:e2e` (for UI changes)

## Security checklist

- [ ] New endpoints check access with the helpers in `server/src/access.ts`
- [ ] No private content can reach search, activity, notifications, emails, webhooks, exports or AI prompts for people who cannot open it
- [ ] No secrets, tokens or personal data are logged or committed
