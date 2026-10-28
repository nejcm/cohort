// Ground truth for evaluation only; never send these names or descriptions to a model.
export const MUTATIONS = {
  confusing_label: 'The "Arrival instructions" link is labelled "Orientation module".',
  hidden_primary: 'The "Review request" button sits below a long irrelevant panel.',
  extra_field: 'The request form requires an unnecessary "Company" field.',
  icon_only: 'The "Contact host" link is an unlabeled envelope icon.',
} as const;

export type Mutation = keyof typeof MUTATIONS;

// Healthy journey: open arrival, open request form, fill name, choose time, review, send.
export const HEALTHY_MINIMUM_ACTIONS = 6;
