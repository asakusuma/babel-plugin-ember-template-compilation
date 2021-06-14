import type { NodePath } from '@babel/traverse';
import type { precompile as glimmerPrecompile } from '@glimmer/compiler';
import type * as Babel from '@babel/core';
import type { types as t } from '@babel/core';
import { resolve } from 'path';

export interface Options {
  templateCompilerPath?: string;
  precompile?: typeof glimmerPrecompile;
  moduleOverrides?: Record<string, Record<string, string>>;
  modules?: {
    [importPath: string]: string | ModuleOptions;
  };
  modulePaths?: string[];
  isProduction?: boolean;
}

interface State {
  opts: Options;
  presentModules: Map<string, ExtendedModuleOptions>;
  allAddedImports: Record<
    string,
    Record<string, { id: t.Identifier; path?: NodePath<t.ImportDeclaration> }>
  >;
  programPath: NodePath<t.Program>;
}

interface ModuleOptions {
  export: string;
  shouldParseScope?: boolean;
  disableTemplateLiteral?: boolean;
  disableFunctionCall?: boolean;
}

type ExtendedModuleOptions = ModuleOptions & {
  modulePath: string;
  originalName: string;
};

interface CompilerOptions {
  isProduction?: boolean;
  strictMode?: boolean;
  locals?: string[] | null;
  insertRuntimeErrors?: boolean;
}

export default function htmlbarsInlinePrecompile(babel: typeof Babel) {
  let t = babel.types;

  const runtimeErrorIIFE = babel.template(
    `(function() {\n  throw new Error('ERROR_MESSAGE');\n})();`
  ) as (replacements: { ERROR_MESSAGE: string }) => t.Statement;

  function parseExpression(invokedName: string, path: NodePath<t.Expression>): unknown {
    switch (path.node.type) {
      case 'ObjectExpression':
        return parseObjectExpression(invokedName, path as NodePath<t.ObjectExpression>);
      case 'ArrayExpression': {
        return parseArrayExpression(invokedName, path as NodePath<t.ArrayExpression>);
      }
      case 'StringLiteral':
      case 'BooleanLiteral':
      case 'NumericLiteral':
        return path.node.value;
      default:
        throw path.buildCodeFrameError(
          `${invokedName} can only accept static options but you passed ${JSON.stringify(
            path.node
          )}`
        );
    }
  }

  function parseArrayExpression(invokedName: string, path: NodePath<t.ArrayExpression>) {
    return path.get('elements').map((element) => {
      if (element.isSpreadElement()) {
        throw element.buildCodeFrameError(`spread element is not allowed here`);
      } else if (element.isExpression()) {
        return parseExpression(invokedName, element);
      }
    });
  }

  function parseScope(invokedName: string, path: NodePath<t.ObjectProperty | t.ObjectMethod>) {
    let body: t.BlockStatement | t.Expression | undefined = undefined;

    if (path.node.type === 'ObjectMethod') {
      body = path.node.body;
    } else {
      let { value } = path.node;
      if (t.isObjectExpression(value)) {
        throw path.buildCodeFrameError(
          `Passing an object as the \`scope\` property to inline templates is no longer supported. Please pass a function that returns an object expression instead.`
        );
      }
      if (t.isFunctionExpression(value) || t.isArrowFunctionExpression(value)) {
        body = value.body;
      }
    }

    let objExpression: t.Expression | undefined | null = undefined;

    if (body?.type === 'ObjectExpression') {
      objExpression = body;
    } else if (body?.type === 'BlockStatement') {
      let returnStatement = body.body[0];

      if (body.body.length !== 1 || returnStatement.type !== 'ReturnStatement') {
        throw new Error(
          'Scope functions can only consist of a single return statement which returns an object expression containing references to in-scope values'
        );
      }

      objExpression = returnStatement.argument;
    }

    if (objExpression?.type !== 'ObjectExpression') {
      throw path.buildCodeFrameError(
        `Scope objects for \`${invokedName}\` must be an object expression containing only references to in-scope values, or a function that returns an object expression containing only references to in-scope values`
      );
    }

    return objExpression.properties.map((prop) => {
      if (t.isSpreadElement(prop)) {
        throw path.buildCodeFrameError(
          `Scope objects for \`${invokedName}\` may not contain spread elements`
        );
      }
      if (t.isObjectMethod(prop)) {
        throw path.buildCodeFrameError(
          `Scope objects for \`${invokedName}\` may not contain methods`
        );
      }

      let { key, value } = prop;
      if (!t.isStringLiteral(key) && !t.isIdentifier(key)) {
        throw path.buildCodeFrameError(
          `Scope objects for \`${invokedName}\` may only contain static property names`
        );
      }

      let propName = name(key);

      if (value.type !== 'Identifier' || value.name !== propName) {
        throw path.buildCodeFrameError(
          `Scope objects for \`${invokedName}\` may only contain direct references to in-scope values, e.g. { ${propName} } or { ${propName}: ${propName} }`
        );
      }

      return propName;
    });
  }

  function parseObjectExpression(
    invokedName: string,
    path: NodePath<t.ObjectExpression>,
    shouldParseScope = false
  ) {
    let result: Record<string, unknown> = {};

    path.get('properties').forEach((property) => {
      let { node } = property;
      if (t.isSpreadElement(node)) {
        throw property.buildCodeFrameError(`${invokedName} does not allow spread element`);
      }

      if (node.computed) {
        throw property.buildCodeFrameError(`${invokedName} can only accept static property names`);
      }

      let { key } = node;
      if (!t.isIdentifier(key) && !t.isStringLiteral(key)) {
        throw property.buildCodeFrameError(`${invokedName} can only accept static property names`);
      }

      let propertyName = name(key);

      if (shouldParseScope && propertyName === 'scope') {
        result.locals = parseScope(invokedName, property as NodePath<typeof node>);
      } else {
        if (t.isObjectMethod(node)) {
          throw property.buildCodeFrameError(
            `${invokedName} does not accept a method for ${propertyName}`
          );
        }
        let valuePath = (property as NodePath<typeof node>).get('value');
        if (!valuePath.isExpression()) {
          throw valuePath.buildCodeFrameError(`must be an expression`);
        }
        result[propertyName] = parseExpression(invokedName, valuePath);
      }
    });

    return result;
  }

  function compileTemplate(
    precompile: typeof glimmerPrecompile,
    template: string,
    templateCompilerIdentifier: t.Identifier,
    _options: CompilerOptions
  ) {
    let options = Object.assign({ contents: template }, _options);

    let precompileResultString: string;

    if (options.insertRuntimeErrors) {
      try {
        precompileResultString = precompile(template, options as any); // TODO
      } catch (error) {
        return runtimeErrorIIFE({ ERROR_MESSAGE: error.message });
      }
    } else {
      precompileResultString = precompile(template, options as any); // TODO
    }

    let precompileResultAST = babel.parse(
      `var precompileResult = ${precompileResultString};`
    ) as t.File;

    let templateExpression = (precompileResultAST.program.body[0] as t.VariableDeclaration)
      .declarations[0].init;

    t.addComment(
      templateExpression!,
      'leading',
      `\n  ${template.replace(/\*\//g, '*\\/')}\n`,
      /* line comment? */ false
    );

    return t.callExpression(templateCompilerIdentifier, [templateExpression!]);
  }

  function ensureImport(exportName: string, moduleName: string, state: State): t.Identifier {
    let moduleOverrides = state.opts.moduleOverrides;

    let addedImports = (state.allAddedImports[moduleName] =
      state.allAddedImports[moduleName] || {});

    if (addedImports[exportName]) return t.identifier(addedImports[exportName].id.name);

    if (moduleOverrides) {
      let glimmerModule = moduleOverrides[moduleName];
      let glimmerExport = glimmerModule?.[exportName];

      if (glimmerExport) {
        exportName = glimmerExport[0];
        moduleName = glimmerExport[1];
      }
    }

    let importDeclarations = state.programPath
      .get('body')
      .filter((n) => n.type === 'ImportDeclaration') as NodePath<t.ImportDeclaration>[];

    let preexistingImportDeclaration = importDeclarations.find(
      (n) => n.node.source.value === moduleName
    );

    if (preexistingImportDeclaration) {
      let importSpecifier = preexistingImportDeclaration.get('specifiers').find(({ node }) => {
        return exportName === 'default'
          ? t.isImportDefaultSpecifier(node)
          : 'imported' in node && name(node.imported) === exportName;
      });

      if (importSpecifier) {
        addedImports[exportName] = { id: importSpecifier.node.local };
      }
    }

    if (!addedImports[exportName]) {
      let uid = state.programPath.scope.generateUidIdentifier(
        exportName === 'default' ? moduleName : exportName
      );

      let newImportSpecifier =
        exportName === 'default'
          ? t.importDefaultSpecifier(uid)
          : t.importSpecifier(uid, t.identifier(exportName));

      let newImport = t.importDeclaration([newImportSpecifier], t.stringLiteral(moduleName));
      (state.programPath as any).unshiftContainer('body', newImport); // TODO
      state.programPath.scope.registerBinding(
        'module',
        state.programPath.get('body.0.specifiers.0') as NodePath
      );

      addedImports[exportName] = {
        id: uid,
        path: state.programPath.get('body.0') as NodePath<t.ImportDeclaration>,
      };
    }

    return t.identifier(addedImports[exportName].id.name);
  }

  let precompile: typeof glimmerPrecompile;

  return {
    visitor: {
      Program(path: NodePath<t.Program>, state: State) {
        state.programPath = path;

        if (state.opts.templateCompilerPath) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          let templateCompiler: any = require(state.opts.templateCompilerPath);
          precompile = templateCompiler.precompile;
        } else if (state.opts.precompile) {
          precompile = state.opts.precompile;
        }

        state.allAddedImports = Object.create(null);

        // Setup other module options and create cache for values
        let modules = state.opts.modules || {
          'htmlbars-inline-precompile': { export: 'default', shouldParseScope: false },
        };

        if (state.opts.modulePaths) {
          let modulePaths = state.opts.modulePaths;

          modulePaths.forEach((path) => (modules[path] = { export: 'default' }));
        }

        let presentModules: State['presentModules'] = new Map();
        let importDeclarations = path
          .get('body')
          .filter((n) => n.type === 'ImportDeclaration') as NodePath<t.ImportDeclaration>[];

        for (let module in modules) {
          let paths = importDeclarations.filter(
            (path) => !path.removed && path.node.source.value === module
          );

          for (let path of paths) {
            let userOptions = modules[module];
            let copiedOptions: ModuleOptions;

            if (typeof userOptions === 'string') {
              // Normalize 'moduleName': 'importSpecifier'
              copiedOptions = { export: userOptions };
            } else {
              // else clone options so we don't mutate it
              copiedOptions = Object.assign({}, userOptions);
            }

            let modulePathExport = copiedOptions.export;
            let importSpecifierPath = path
              .get('specifiers')
              .find(({ node }) =>
                modulePathExport === 'default'
                  ? t.isImportDefaultSpecifier(node)
                  : t.isImportSpecifier(node) && name(node.imported) === modulePathExport
              );

            if (importSpecifierPath) {
              let localName = importSpecifierPath.node.local.name;

              // TODO: ???
              let localImportId = path.scope.generateUidIdentifierBasedOnNode(path.node);

              path.scope.rename(localName, localImportId.name);

              // If it was the only specifier, remove the whole import, else
              // remove the specifier
              if (path.node.specifiers.length === 1) {
                path.remove();
              } else {
                importSpecifierPath.remove();
              }
              presentModules.set(
                localImportId.name,
                Object.assign(copiedOptions, {
                  modulePath: module,
                  originalName: localName,
                })
              );
            }
          }
        }

        state.presentModules = presentModules;
      },

      TaggedTemplateExpression(path: NodePath<t.TaggedTemplateExpression>, state: State) {
        let tagPath = path.get('tag');
        let options;
        if (tagPath.isIdentifier()) {
          options = state.presentModules.get(tagPath.node.name);
        }

        if (!options) {
          return;
        }

        if (options.disableTemplateLiteral) {
          throw path.buildCodeFrameError(
            `Attempted to use \`${options.originalName}\` as a template tag, but it can only be called as a function with a string passed to it: ${options.originalName}('content here')`
          );
        }

        if (path.node.quasi.expressions.length) {
          throw path.buildCodeFrameError(
            'placeholders inside a tagged template string are not supported'
          );
        }

        let template = path.node.quasi.quasis.map((quasi) => quasi.value.cooked).join('');

        let { isProduction } = state.opts;
        let locals = null;
        let strictMode = false;

        let emberIdentifier = ensureImport(
          'createTemplateFactory',
          '@ember/template-factory',
          state
        );

        path.replaceWith(
          compileTemplate(precompile, template, emberIdentifier, {
            isProduction,
            locals,
            strictMode,
          })
        );
      },

      CallExpression(path: NodePath<t.CallExpression>, state: State) {
        let calleePath = path.get('callee');
        let options;
        if (calleePath.isIdentifier()) {
          options = state.presentModules.get(calleePath.node.name);
        }

        if (!options) {
          return;
        }

        if (options.disableFunctionCall) {
          throw path.buildCodeFrameError(
            `Attempted to use \`${options.originalName}\` as a function call, but it can only be used as a template tag: ${options.originalName}\`content here\``
          );
        }

        let [firstArg, secondArg, ...restArgs] = path.get('arguments');

        let template;

        switch (firstArg?.node.type) {
          case 'StringLiteral':
            template = firstArg.node.value;
            break;
          case 'TemplateLiteral':
            if (firstArg.node.expressions.length) {
              throw path.buildCodeFrameError(
                'placeholders inside a template string are not supported'
              );
            } else {
              template = firstArg.node.quasis.map((quasi) => quasi.value.cooked).join('');
            }
            break;
          case 'TaggedTemplateExpression':
            throw path.buildCodeFrameError(
              `tagged template strings inside ${options.originalName} are not supported`
            );
          default:
            throw path.buildCodeFrameError(
              'hbs should be invoked with at least a single argument: the template string'
            );
        }

        let compilerOptions: CompilerOptions;

        if (!secondArg) {
          compilerOptions = {};
        } else {
          if (!secondArg.isObjectExpression()) {
            throw path.buildCodeFrameError(
              'hbs can only be invoked with 2 arguments: the template string, and any static options'
            );
          }

          compilerOptions = parseObjectExpression(options.originalName, secondArg, true);
        }
        if (restArgs.length > 0) {
          throw path.buildCodeFrameError(
            'hbs can only be invoked with 2 arguments: the template string, and any static options'
          );
        }

        let { isProduction } = state.opts;

        // allow the user specified value to "win" over ours
        if (!('isProduction' in compilerOptions)) {
          compilerOptions.isProduction = isProduction;
        }

        path.replaceWith(
          compileTemplate(
            precompile,
            template,
            ensureImport('createTemplateFactory', '@ember/template-factory', state),
            compilerOptions
          )
        );
      },
    },
  };
}

htmlbarsInlinePrecompile._parallelBabel = {
  requireFile: __filename,
};

htmlbarsInlinePrecompile.baseDir = function () {
  return resolve(__dirname, '..');
};

function name(node: t.StringLiteral | t.Identifier): string {
  if (node.type === 'StringLiteral') {
    return node.value;
  } else {
    return node.name;
  }
}
