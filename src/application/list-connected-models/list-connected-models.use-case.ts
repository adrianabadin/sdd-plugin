import { formatConnectedModels } from "../../domain/model/format-connected-models.js";
import type { NotifierPort } from "../../ports/index.js";
import type {
  ListConnectedModelsInput,
  ListConnectedModelsResult,
} from "./list-connected-models.input.js";

/**
 * Use case: format the refreshed model list and hand it to the
 * notifier. Pure orchestration — formatting only.
 */
export class ListConnectedModelsUseCase {
  constructor(private readonly notifier: NotifierPort) {}

  async execute(input: ListConnectedModelsInput): Promise<ListConnectedModelsResult> {
    const summary = formatConnectedModels(input.refreshed);
    await this.notifier.showModels(input.refreshed, input);
    return { count: input.refreshed.length, summary };
  }
}
