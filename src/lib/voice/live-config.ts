import { Modality, type LiveConnectConfig } from "@google/genai";
import { voiceLanguage } from "@/lib/voice-input";

export function liveConfig(language: string): LiveConnectConfig {
  const selected = voiceLanguage(language);
  return {
    responseModalities: [Modality.AUDIO],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: `You are QORVYNA, a helpful live voice and visual assistant. Give concise, conversational spoken replies. ${selected.code === "auto" ? "Respond in the language the user speaks, including code-switching." : `Respond in ${selected.label}.`} Do not translate everything into English. Explain what you can actually see; ask for a clearer camera view when needed. This session has no access to chat history, device controls or agent tools. Never claim to have executed actions.`,
  };
}
