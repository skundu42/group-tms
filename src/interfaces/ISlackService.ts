import {CrcV2_CirclesBackingInitiated} from "@circles-sdk/data/dist/events/events";

export interface ISlackService {

    notifyBackingNotCompleted(backingInitiatedEvent: CrcV2_CirclesBackingInitiated, reason: string): Promise<void>;

    notifySlackStartorCrash(message: string): Promise<void>;
}