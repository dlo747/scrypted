import { MediaStreamConfiguration, MediaStreamOptions, Setting } from "@scrypted/sdk";
import { autoconfigureCodecs as ac } from '../../../common/src/autoconfigure-codecs';
import { UrlMediaStreamOptions } from "../../ffmpeg-camera/src/common";
import { OnvifCameraAPI } from "./onvif-api";

export function computeInterval(fps: number, govLength: number) {
    if (!fps || !govLength)
        return;
    return govLength / fps * 1000;
}

const onvifToFfmpegVideoCodecMap = {
    'h264': 'h264',
    'h265': 'h265',
    'hevc': 'h265',
};

const onvifToFfmpegAudioCodecMap = {
    'mp4a': 'aac',
    'aac': 'aac',
    'PCMU': 'pcm_mulaw',
    'PCMA': 'pcm_alaw',
};

export function fromOnvifAudioCodec(codec: string) {
    codec = codec?.toLowerCase();
    return onvifToFfmpegAudioCodecMap[codec] || codec;
}

export function fromOnvifVideoCodec(codec: string) {
    codec = codec?.toLowerCase();
    return onvifToFfmpegVideoCodecMap[codec] || codec;
}

export function toOnvifAudioCodec(codec: string) {
    for (const [key, value] of Object.entries(onvifToFfmpegAudioCodecMap)) {
        if (value === codec)
            return key;
    }
    return codec;
}

export function toOnvifVideoCodec(codec: string) {
    for (const [key, value] of Object.entries(onvifToFfmpegVideoCodecMap)) {
        if (value === codec)
            return key;
    }
    return codec;
}

export function computeBitrate(bitrate: number) {
    if (!bitrate)
        return;
    return bitrate * 1000;
}

export async function autoconfigureSettings(console: Console, client: OnvifCameraAPI) {
    return ac(
        () => getCodecs(console, client),
        (options) => configureCodecs(console, client, options)
    );
}

export async function configureCodecs(console: Console, client: OnvifCameraAPI, options: MediaStreamOptions): Promise<MediaStreamConfiguration> {
    client.profiles = undefined;
    const profiles: any[] = await client.getProfiles();
    const profile = profiles.find(profile => profile.$.token === options.id);
    const vc = profile.videoEncoderConfiguration;
    const ac = profile.audioEncoderConfiguration;

    const { video: videoOptions, audio: audioOptions } = options;

    if (videoOptions?.codec) {
        let key: string;
        switch (videoOptions.codec) {
            case 'h264':
                key = 'H264';
                break;
            case 'h265':
                key = 'H265';
                break;
        }
        if (key) {
            vc.encoding = key;

            if (videoOptions?.keyframeInterval) {
                vc[key] ||= {};
                vc[key].govLength = videoOptions?.keyframeInterval;
            }
            if (videoOptions?.profile) {
                let profile: string;
                switch (videoOptions.profile) {
                    case 'baseline':
                        profile = 'Baseline';
                        break;
                    case 'main':
                        profile = 'Main';
                        break;
                    case 'high':
                        profile = 'High';
                        break;
                }
                if (profile) {
                    vc[key] ||= {};
                    vc[key].profile = profile;
                }
            }
        }
    }

    if (videoOptions?.width && videoOptions?.height) {
        vc.resolution ||= {};
        vc.resolution.width = videoOptions?.width;
        vc.resolution.height = videoOptions?.height;
    }

    if (videoOptions?.bitrate) {
        vc.rateControl ||= {};
        vc.rateControl.bitrateLimit = Math.floor(videoOptions?.bitrate / 1000);
    }

    // can't be set by onvif. But see if it is settable and doesn't match to direct user.
    if (videoOptions?.bitrateControl && vc.rateControl?.$?.ConstantBitRate !== undefined) {
        const constant = videoOptions?.bitrateControl === 'constant';
        if (vc.rateControl.$.ConstantBitRate !== constant)
            throw new Error(options.id + ': camera video Bitrate Type must be manually set to ' + videoOptions?.bitrateControl + ' in the camera web admin.');
    }

    if (videoOptions?.fps) {
        vc.rateControl ||= {};
        vc.rateControl.frameRateLimit = videoOptions?.fps;
        vc.rateControl.encodingInterval = 1;
    }

    await client.setVideoEncoderConfiguration(vc);
    const configuredVideo = await client.getVideoEncoderConfigurationOptions(profile.$.token, vc.$.token);
    client.profiles = undefined;
    const codecs = await getCodecs(console, client);
    const foundCodec = codecs.find(codec => codec.id === options.id);
    const ret: MediaStreamConfiguration = {
        ...foundCodec,
    };
    ret.video = {
        ...ret.video,
        ...configuredVideo,
    };
    if (videoOptions?.bitrateControl) {
        ret.video.bitrateControls = ['constant', 'variable'];
    }
    return ret;
}

export async function getCodecs(console: Console, client: OnvifCameraAPI) {
    const profiles: any[] = await client.getProfiles();
    const ret: UrlMediaStreamOptions[] = [];
    for (const { $, name, videoEncoderConfiguration, audioEncoderConfiguration } of profiles) {
        try {
            ret.push({
                id: $.token,
                metadata: {
                    videoId: videoEncoderConfiguration?.$?.token,
                    audioId: audioEncoderConfiguration?.$?.token,
                },
                name: name,
                container: 'rtsp',
                url: await client.getStreamUrl($.token),
                video: {
                    fps: videoEncoderConfiguration?.rateControl?.frameRateLimit,
                    bitrate: computeBitrate(videoEncoderConfiguration?.rateControl?.bitrateLimit),
                    width: videoEncoderConfiguration?.resolution?.width,
                    height: videoEncoderConfiguration?.resolution?.height,
                    codec: fromOnvifVideoCodec(videoEncoderConfiguration?.encoding),
                    keyframeInterval: videoEncoderConfiguration?.$?.GovLength,
                    bitrateControl: videoEncoderConfiguration?.rateControl?.$?.ConstantBitRate != null
                        ? (videoEncoderConfiguration?.rateControl?.$.ConstantBitRate ? 'constant' : 'variable')
                        : undefined,
                },
                audio: {
                    bitrate: computeBitrate(audioEncoderConfiguration?.bitrate),
                    codec: fromOnvifAudioCodec(audioEncoderConfiguration?.encoding),
                }
            })
        }
        catch (e) {
            console.error('error retrieving onvif profile', $.token, e);
        }
    }

    return ret;
}