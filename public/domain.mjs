export function company(name, industry) {
  return {
    name, industry, greeting: `Welcome to ${name}. How can we help?`,
    services: [{name: "Consultation", minutes: 30}], questions: ["What can we help you with?"],
    faq: [], staff: ["Service team"], startHour: 9, endHour: 17, followupMinutes: 60,
    followup: "Thanks for booking with {company}. Reply if you need to change your appointment.",
    billing: "inactive", conversations: {}, bookings: [], jobs: []
  };
}

export function startConversation(state, input, id) {
  const name = String(input.name || "").trim().slice(0, 120);
  const phone = String(input.phone || "").trim();
  if (!name || (phone && !/^\+[1-9]\d{7,14}$/.test(phone))) {
    throw new Error("Enter your name and, if provided, a phone number in international format.");
  }
  const conversation = {name, phone, consent: input.consent === true && !!phone,
    consentAt: input.consent === true && phone ? new Date().toISOString() : null,
    answers: [], messages: [{speaker: "Receptionist", text: state.greeting}]};
  if (state.questions[0]) conversation.messages.push({speaker: "Receptionist", text: state.questions[0]});
  state.conversations[id] = conversation;
  return conversation;
}

export function receive(state, conversation, value) {
  const text = String(value || "").trim();
  if (!text || text.length > 2000) throw new Error("Enter a message up to 2,000 characters.");
  conversation.messages.push({speaker: "You", text});
  const question = state.questions[conversation.answers.length];
  let reply;
  if (question) {
    conversation.answers.push({question, answer: text});
    reply = state.questions[conversation.answers.length] || "Thanks. You can choose a service and reserve a time below.";
  } else {
    reply = state.faq.find(item => text.toLowerCase().includes(item.question.toLowerCase()))?.answer ||
      `Our services include ${state.services.map(item => item.name).join(", ")}. For other questions, our team can help.`;
  }
  conversation.messages.push({speaker: "Receptionist", text: reply});
}

export function available(state, serviceName, member, now = Date.now()) {
  const service = state.services.find(item => item.name === serviceName);
  if (!service || !state.staff.includes(member)) return [];
  const slots = [];
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  for (let day = 0; day < 14; day++, date.setUTCDate(date.getUTCDate() + 1)) {
    if ([0, 6].includes(date.getUTCDay())) continue;
    for (let minute = state.startHour * 60; minute + service.minutes <= state.endHour * 60; minute += 30) {
      const start = +date + minute * 60000;
      const end = start + service.minutes * 60000;
      if (start <= now || state.bookings.some(booking => booking.member === member &&
        Date.parse(booking.start) < end && Date.parse(booking.end) > start)) continue;
      slots.push({start: new Date(start).toISOString(), end: new Date(end).toISOString()});
    }
  }
  return slots;
}

export function book(state, conversationId, input, id, now = Date.now()) {
  const conversation = state.conversations[conversationId];
  const existing = state.bookings.find(item => item.conversationId === conversationId);
  if (existing) return existing;
  if (conversation.answers.length < state.questions.length) throw new Error("Complete the intake questions first.");
  const slot = available(state, input.service, input.member, now).find(item => item.start === input.start);
  if (!slot) throw new Error("That time is unavailable. Choose another time.");
  const booking = {...slot, id, conversationId, name: conversation.name, service: input.service, member: input.member};
  state.bookings.push(booking);
  conversation.booked = true;
  conversation.messages.push({speaker: "Receptionist", text: `Booked: ${booking.service} at ${booking.start.replace("T", " ").slice(0, 16)} UTC.`});
  if (conversation.consent && state.followup) {
    state.jobs.push({id, bookingId: id, phone: conversation.phone,
      text: state.followup.replaceAll("{company}", state.name),
      due: new Date(now + state.followupMinutes * 60000).toISOString(), status: "scheduled"});
  }
  return booking;
}
