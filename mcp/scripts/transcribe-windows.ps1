# WAV-only offline transcription. Never opens the default microphone or network.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    Add-Type -AssemblyName System.Speech
    # CLR event handlers avoid PowerShell runspace callbacks on SAPI worker threads.
    Add-Type -ReferencedAssemblies System.Speech -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Threading;

public sealed class UMouseSpeechOutput {
    public string Text { get; set; }
    public double Confidence { get; set; }
}

public static class UMouseOfflineSpeech {
    public static UMouseSpeechOutput Transcribe(string file, string language) {
        RecognizerInfo selected = null;
        foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers()) {
            if (String.Equals(info.Culture.Name, language, StringComparison.OrdinalIgnoreCase)) {
                selected = info;
                break;
            }
        }
        if (selected == null) throw new InvalidOperationException("Recognizer language is not installed.");
        using (var engine = new SpeechRecognitionEngine(selected))
        using (var completed = new ManualResetEvent(false)) {
            var texts = new List<string>();
            double confidence = 0;
            Exception failure = null;
            engine.LoadGrammar(new DictationGrammar());
            engine.SetInputToWaveFile(file);
            engine.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs args) {
                texts.Add(args.Result.Text);
                confidence += args.Result.Confidence;
            };
            engine.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs args) {
                failure = args.Error;
                completed.Set();
            };
            engine.RecognizeAsync(RecognizeMode.Multiple);
            // The parent also enforces timeout/cancellation and kills this process.
            if (!completed.WaitOne(TimeSpan.FromMinutes(5))) {
                engine.RecognizeAsyncCancel();
                throw new TimeoutException("Recognition did not complete.");
            }
            if (failure != null) throw new InvalidOperationException("Recognition failed.");
            string separator = language.StartsWith("zh", StringComparison.OrdinalIgnoreCase)
                || language.StartsWith("ja", StringComparison.OrdinalIgnoreCase) ? "" : " ";
            return new UMouseSpeechOutput {
                Text = String.Join(separator, texts.ToArray()),
                Confidence = texts.Count == 0 ? 0 : confidence / texts.Count
            };
        }
    }
}
'@
    $result = [UMouseOfflineSpeech]::Transcribe($env:UMOUSE_TRANSCRIBE_WAV, $env:UMOUSE_TRANSCRIBE_LANGUAGE)
    [pscustomobject]@{
        text = $result.Text
        provider = 'windows-speech'
        language = $env:UMOUSE_TRANSCRIBE_LANGUAGE
        confidence = $result.Confidence
    } | ConvertTo-Json -Compress
} catch {
    # Do not emit exception bodies: they can include private local paths or audio content.
    [Console]::Error.WriteLine('Windows offline speech recognition failed.')
    exit 1
}
