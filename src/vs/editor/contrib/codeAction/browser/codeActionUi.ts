/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getDomNodePagePosition } from 'vs/base/browser/dom';
import { IAnchor } from 'vs/base/browser/ui/contextview/contextview';
import { IAction } from 'vs/base/common/actions';
import { onUnexpectedError } from 'vs/base/common/errors';
import { Lazy } from 'vs/base/common/lazy';
import { Disposable, MutableDisposable } from 'vs/base/common/lifecycle';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IPosition, Position } from 'vs/editor/common/core/position';
import { ScrollType } from 'vs/editor/common/editorCommon';
import { CodeActionTriggerType } from 'vs/editor/common/languages';
import { CodeActionKeybindingResolver } from 'vs/editor/contrib/codeAction/browser/codeActionKeybindingResolver';
import { toMenuItems } from 'vs/editor/contrib/codeAction/browser/codeActionMenu';
import { MessageController } from 'vs/editor/contrib/message/browser/messageController';
import { localize } from 'vs/nls';
import { IActionWidgetService } from 'vs/platform/actionWidget/browser/actionWidget';
import { ICommandService } from 'vs/platform/commands/common/commands';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { CodeActionAutoApply, CodeActionItem, CodeActionSet, CodeActionTrigger } from '../common/types';
import { CodeActionsState } from './codeActionModel';
import { LightBulbWidget } from './lightBulbWidget';
import { IActionListDelegate } from 'vs/platform/actionWidget/browser/actionList';

export interface IActionShowOptions {
	readonly includeDisabledActions?: boolean;
	readonly fromLightbulb?: boolean;
}

export class CodeActionUi extends Disposable {

	private readonly _lightBulbWidget: Lazy<LightBulbWidget>;
	private readonly _activeCodeActions = this._register(new MutableDisposable<CodeActionSet>());

	private readonly _resolver: CodeActionKeybindingResolver;

	#disposed = false;

	private _showDisabled = false;

	constructor(
		private readonly _editor: ICodeEditor,
		quickFixActionId: string,
		preferredFixActionId: string,
		private readonly delegate: {
			applyCodeAction: (action: CodeActionItem, regtriggerAfterApply: boolean, preview: boolean) => Promise<void>;
		},
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IActionWidgetService private readonly _actionWidgetService: IActionWidgetService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();

		this._lightBulbWidget = new Lazy(() => {
			const widget = this._register(instantiationService.createInstance(LightBulbWidget, this._editor, quickFixActionId, preferredFixActionId));
			this._register(widget.onClick(e => this.showCodeActionList(e.actions, e, { includeDisabledActions: false, fromLightbulb: true })));
			return widget;
		});

		this._resolver = instantiationService.createInstance(CodeActionKeybindingResolver);

		this._register(this._editor.onDidLayoutChange(() => this._actionWidgetService.hide()));
	}

	override dispose() {
		this.#disposed = true;
		super.dispose();
	}

	public async update(newState: CodeActionsState.State): Promise<void> {
		if (newState.type !== CodeActionsState.Type.Triggered) {
			this._lightBulbWidget.rawValue?.hide();
			return;
		}

		let actions: CodeActionSet;
		try {
			actions = await newState.actions;
		} catch (e) {
			onUnexpectedError(e);
			return;
		}

		if (this.#disposed) {
			return;
		}

		this._lightBulbWidget.value.update(actions, newState.trigger, newState.position);

		if (newState.trigger.type === CodeActionTriggerType.Invoke) {
			if (newState.trigger.filter?.include) { // Triggered for specific scope
				// Check to see if we want to auto apply.

				const validActionToApply = this.tryGetValidActionToApply(newState.trigger, actions);
				if (validActionToApply) {
					try {
						this._lightBulbWidget.value.hide();
						await this.delegate.applyCodeAction(validActionToApply, false, false);
					} finally {
						actions.dispose();
					}
					return;
				}

				// Check to see if there is an action that we would have applied were it not invalid
				if (newState.trigger.context) {
					const invalidAction = this.getInvalidActionThatWouldHaveBeenApplied(newState.trigger, actions);
					if (invalidAction && invalidAction.action.disabled) {
						MessageController.get(this._editor)?.showMessage(invalidAction.action.disabled, newState.trigger.context.position);
						actions.dispose();
						return;
					}
				}
			}

			const includeDisabledActions = !!newState.trigger.filter?.include;
			if (newState.trigger.context) {
				if (!actions.allActions.length || !includeDisabledActions && !actions.validActions.length) {
					MessageController.get(this._editor)?.showMessage(newState.trigger.context.notAvailableMessage, newState.trigger.context.position);
					this._activeCodeActions.value = actions;
					actions.dispose();
					return;
				}
			}

			this._activeCodeActions.value = actions;
			this.showCodeActionList(actions, this.toCoords(newState.position), { includeDisabledActions, fromLightbulb: false });
		} else {
			// auto magically triggered
			if (this._actionWidgetService.isVisible) {
				// TODO: Figure out if we should update the showing menu?
				actions.dispose();
			} else {
				this._activeCodeActions.value = actions;
			}
		}
	}

	private getInvalidActionThatWouldHaveBeenApplied(trigger: CodeActionTrigger, actions: CodeActionSet): CodeActionItem | undefined {
		if (!actions.allActions.length) {
			return undefined;
		}

		if ((trigger.autoApply === CodeActionAutoApply.First && actions.validActions.length === 0)
			|| (trigger.autoApply === CodeActionAutoApply.IfSingle && actions.allActions.length === 1)
		) {
			return actions.allActions.find(({ action }) => action.disabled);
		}

		return undefined;
	}

	private tryGetValidActionToApply(trigger: CodeActionTrigger, actions: CodeActionSet): CodeActionItem | undefined {
		if (!actions.validActions.length) {
			return undefined;
		}

		if ((trigger.autoApply === CodeActionAutoApply.First && actions.validActions.length > 0)
			|| (trigger.autoApply === CodeActionAutoApply.IfSingle && actions.validActions.length === 1)
		) {
			return actions.validActions[0];
		}

		return undefined;
	}

	public async showCodeActionList(actions: CodeActionSet, at: IAnchor | IPosition, options: IActionShowOptions): Promise<void> {
		const editorDom = this._editor.getDomNode();
		if (!editorDom) {
			return;
		}

		const actionsToShow = options.includeDisabledActions && (this._showDisabled || actions.validActions.length === 0) ? actions.allActions : actions.validActions;
		if (!actionsToShow.length) {
			return;
		}

		const anchor = Position.isIPosition(at) ? this.toCoords(at) : at;

		const delegate: IActionListDelegate<CodeActionItem> = {
			onSelect: async (action: CodeActionItem, preview?: boolean) => {
				this.delegate.applyCodeAction(action, /* retrigger */ true, !!preview ? preview : false);
				this._actionWidgetService.hide();
			},
			onHide: () => {
				this._editor?.focus();
			}
		};

		this._actionWidgetService.show(
			'codeActionWidget',
			true,
			toMenuItems(actionsToShow, this._shouldShowHeaders(), this._resolver.getResolver()),
			delegate,
			anchor,
			editorDom,
			this._getActionBarActions(actions, at, options));
	}

	private toCoords(position: IPosition): IAnchor {
		if (!this._editor.hasModel()) {
			return { x: 0, y: 0 };
		}

		this._editor.revealPosition(position, ScrollType.Immediate);
		this._editor.render();

		// Translate to absolute editor position
		const cursorCoords = this._editor.getScrolledVisiblePosition(position);
		const editorCoords = getDomNodePagePosition(this._editor.getDomNode());
		const x = editorCoords.left + cursorCoords.left;
		const y = editorCoords.top + cursorCoords.top + cursorCoords.height;

		return { x, y };
	}

	private _shouldShowHeaders(): boolean {
		const model = this._editor?.getModel();
		return this._configurationService.getValue('editor.codeActionWidget.showHeaders', { resource: model?.uri });
	}

	private _getActionBarActions(actions: CodeActionSet, at: IAnchor | IPosition, options: IActionShowOptions): IAction[] {
		if (options.fromLightbulb) {
			return [];
		}

		const resultActions = actions.documentation.map((command): IAction => ({
			id: command.id,
			label: command.title,
			tooltip: command.tooltip ?? '',
			class: undefined,
			enabled: true,
			run: () => this._commandService.executeCommand(command.id, ...(command.commandArguments ?? [])),
		}));

		if (options.includeDisabledActions && actions.validActions.length > 0 && actions.allActions.length !== actions.validActions.length) {
			resultActions.push(this._showDisabled ? {
				id: 'hideMoreActions',
				label: localize('hideMoreActions', 'Hide Disabled'),
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					this._showDisabled = false;
					return this.showCodeActionList(actions, at, options);
				}
			} : {
				id: 'showMoreActions',
				label: localize('showMoreActions', 'Show Disabled'),
				enabled: true,
				tooltip: '',
				class: undefined,
				run: () => {
					this._showDisabled = true;
					return this.showCodeActionList(actions, at, options);
				}
			});
		}

		return resultActions;
	}
}
