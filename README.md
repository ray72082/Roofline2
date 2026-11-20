# Roofline

Roofline is a workspace for service businesses to configure their receptionist, collect customer intake, reserve staff time, and schedule SMS follow-ups.

## Run the persistent app

Use Node.js 24 or later.

```sh
npm start
npm test
```

Open http://localhost:3000, create an account, and add a company. Configure the company under **Company setup**, then open its receptionist link. Answer the intake questions, choose a staff member and time, and confirm the booking. The workspace shows the conversation and appointment. A customer who supplies a mobile number and affirmatively opts in will also have a follow-up scheduled.

The booking calendar uses weekdays and UTC. Selecting staff assigns availability and bookings. Staff entries are scheduling resources. Workspace accounts currently have owner access to the companies they create.

## Run the browser-only demo

Serve the `public` directory at a web root, for example with `python -m http.server 8080 --directory public`. It includes two sample companies with browser-local state. Use sample contact details. Billing and follow-up delivery are simulated. Customers and staff need the same browser profile to see the same demo data.

## Provider configuration

Set credentials in the host's secret manager. Test with controlled accounts and recipients.

| Variable | Purpose |
| --- | --- |
| `PORT`, `HOST` | HTTP listener, default 3000 and 0.0.0.0 |
| `ROOFLINE_DB` | SQLite path on a persistent writable volume |
| `ROOFLINE_SECURE_COOKIE=1` | Secure session cookies behind HTTPS |
| `ROOFLINE_ORIGIN` | Exact public HTTPS origin for checkout and SMS webhook validation |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Optional Responses API for FAQ replies. Without credentials or when requests fail, the receptionist uses company FAQs and a rules-based response |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Stripe Checkout, customer portal and subscription webhook configuration. Use a recurring test price for verification |
| `ROOFLINE_SMS_COMPANIES` | JSON object keyed by Roofline company ID, each with `accountSid`, `authToken` and `messagingServiceSid` |

Configure Stripe to send subscription created, updated, and deleted events to `/hooks/stripe`. Configure each Twilio Messaging Service to forward opt-out webhooks to `/hooks/sms/<company-id>`. Without company Twilio credentials, the worker marks due jobs as simulated. With credentials, submitted status means Twilio accepted the message. Delivery receipts remain to be implemented. A request with an ambiguous outcome is marked for review to avoid duplicate sends.

Deploy the server as a long-running process on a host with persistent storage. Use one instance, put HTTPS in front of it, preserve the database and its WAL files, and restart the worker with the server. There is no external calendar sync or voice channel in this implementation. Stripe state is recorded per company. Subscription-based access enforcement, staff invitations, and plan entitlement rules are outstanding.
