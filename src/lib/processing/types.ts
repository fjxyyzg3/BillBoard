export type ProcessingChoices = {
  ai: boolean;
  voice: boolean;
  services: { primary: "wheelmaker"; speechConfigured: boolean };
};

export type ProcessingCapability = "ai" | "voice";
